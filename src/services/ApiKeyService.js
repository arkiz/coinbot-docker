const db = require('../config/database');
const CryptoUtil = require('../utils/CryptoUtil');

class ApiKeyService {
    constructor(userId) {
        this.userId = userId;
    }

    // 사용자의 모든 API 키 조회 (마스킹된 형태)
    async getUserApiKeys() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    uec.id, uec.exchange_id, uec.is_active, uec.is_verified,
                    uec.last_tested_at, uec.last_test_result, uec.created_at,
                    e.name as exchange_name, e.type as exchange_type
                FROM user_exchange_credentials uec
                JOIN exchanges e ON uec.exchange_id = e.id
                WHERE uec.user_id = ?
                ORDER BY e.type, e.name
            `, [this.userId]);
            connection.release();

            return rows.map(row => ({
                ...row,
                api_key_masked: '****',  // 보안상 마스킹
                has_credentials: true
            }));
        } catch (error) {
            console.error(`사용자 ${this.userId} API 키 목록 조회 오류:`, error);
            throw error;
        }
    }

    // API 키 저장 (암호화하여 저장)
    async saveApiKey(exchangeId, apiKey, secretKey, passphrase = null) {
        try {
            // 입력값 검증
            if (!apiKey || !secretKey) {
                throw new Error('API 키와 시크릿 키는 필수입니다');
            }

            // 거래소별 키 형식 검증
            const connection = await db.getConnection();
            const [exchangeRows] = await connection.execute('SELECT name FROM exchanges WHERE id = ?', [exchangeId]);
            
            if (exchangeRows.length === 0) {
                connection.release();
                throw new Error('존재하지 않는 거래소입니다');
            }

            const exchangeName = exchangeRows[0].name;
            let keyType = 'general';
            if (exchangeName === '업비트') keyType = 'upbit';
            else if (exchangeName === '바이낸스') keyType = 'binance';

            const validation = CryptoUtil.validateApiKey(apiKey, keyType);
            if (!validation.valid) {
                connection.release();
                throw new Error(validation.message);
            }

            // API 키 암호화
            const encryptedApiKey = CryptoUtil.encrypt(apiKey);
            const encryptedSecretKey = CryptoUtil.encrypt(secretKey);
            const encryptedPassphrase = passphrase ? CryptoUtil.encrypt(passphrase) : null;

            // DB에 저장 (UPSERT)
            await connection.execute(`
                INSERT INTO user_exchange_credentials 
                (user_id, exchange_id, api_key, secret_key, passphrase, is_active, is_verified, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, TRUE, FALSE, NOW(), NOW())
                ON DUPLICATE KEY UPDATE 
                api_key = VALUES(api_key),
                secret_key = VALUES(secret_key),
                passphrase = VALUES(passphrase),
                is_verified = FALSE,
                last_test_result = NULL,
                updated_at = VALUES(updated_at)
            `, [this.userId, exchangeId, encryptedApiKey, encryptedSecretKey, encryptedPassphrase]);

            connection.release();
            
            console.log(`사용자 ${this.userId} API 키 저장 완료: ${exchangeName}`);
            return true;
        } catch (error) {
            console.error(`사용자 ${this.userId} API 키 저장 오류:`, error);
            throw error;
        }
    }

    // 복호화된 API 키 조회 (내부 사용용 - 보안 주의)
    async getDecryptedApiKey(credentialId) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT api_key, secret_key, passphrase, e.name as exchange_name
                FROM user_exchange_credentials uec
                JOIN exchanges e ON uec.exchange_id = e.id
                WHERE uec.id = ? AND uec.user_id = ? AND uec.is_verified = TRUE
            `, [credentialId, this.userId]);
            connection.release();

            if (rows.length === 0) {
                throw new Error('인증된 API 키를 찾을 수 없습니다');
            }

            const credential = rows[0];
            return {
                api_key: CryptoUtil.decrypt(credential.api_key),
                secret_key: CryptoUtil.decrypt(credential.secret_key),
                passphrase: credential.passphrase ? CryptoUtil.decrypt(credential.passphrase) : null,
                exchange_name: credential.exchange_name
            };
        } catch (error) {
            console.error(`복호화된 API 키 조회 오류:`, error);
            throw error;
        }
    }

    // API 키 연결 테스트
    async testApiKey(credentialId) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT uec.*, e.name as exchange_name
                FROM user_exchange_credentials uec
                JOIN exchanges e ON uec.exchange_id = e.id
                WHERE uec.id = ? AND uec.user_id = ?
            `, [credentialId, this.userId]);

            if (rows.length === 0) {
                connection.release();
                throw new Error('API 키를 찾을 수 없습니다');
            }

            const credential = rows[0];
            
            // API 키 복호화
            const apiKey = CryptoUtil.decrypt(credential.api_key);
            const secretKey = CryptoUtil.decrypt(credential.secret_key);
            const passphrase = credential.passphrase ? CryptoUtil.decrypt(credential.passphrase) : null;

            if (!apiKey || !secretKey) {
                await connection.execute(`
                    UPDATE user_exchange_credentials 
                    SET is_verified = FALSE, last_tested_at = NOW(), last_test_result = 'DECRYPTION_FAILED'
                    WHERE id = ?
                `, [credentialId]);
                connection.release();
                throw new Error('API 키 복호화에 실패했습니다');
            }

            // 실제 거래소 API 테스트
            console.log(`API 키 테스트 시작: ${credential.exchange_name} (사용자 ${this.userId})`);
            const ExchangeService = require('./ExchangeService');
            const balance = await ExchangeService.getBalance(credential.exchange_id, apiKey, secretKey, passphrase);

            // 테스트 성공 시 결과 저장
            await connection.execute(`
                UPDATE user_exchange_credentials 
                SET is_verified = TRUE, last_tested_at = NOW(), last_test_result = 'OK'
                WHERE id = ?
            `, [credentialId]);

            connection.release();

            console.log(`API 키 테스트 성공: ${credential.exchange_name} (사용자 ${this.userId})`);
            return { 
                success: true, 
                message: `✅ ${credential.exchange_name} 연결 성공`,
                balance: balance
            };

        } catch (error) {
            // 테스트 실패 시 결과 저장
            try {
                const connection = await db.getConnection();
                await connection.execute(`
                    UPDATE user_exchange_credentials 
                    SET is_verified = FALSE, last_tested_at = NOW(), last_test_result = ?
                    WHERE id = ?
                `, [error.message.substring(0, 100), credentialId]);
                connection.release();
            } catch (dbError) {
                console.error('테스트 결과 저장 실패:', dbError);
            }

            console.error(`API 키 테스트 실패 (ID: ${credentialId}):`, error.message);
            return { 
                success: false, 
                message: `❌ 연결 실패: ${error.message}` 
            };
        }
    }

    // API 키 삭제
    async deleteApiKey(credentialId) {
        try {
            const connection = await db.getConnection();
            const [result] = await connection.execute(
                'DELETE FROM user_exchange_credentials WHERE id = ? AND user_id = ?',
                [credentialId, this.userId]
            );
            connection.release();

            if (result.affectedRows === 0) {
                throw new Error('삭제할 API 키를 찾을 수 없습니다');
            }

            console.log(`사용자 ${this.userId} API 키 삭제 완료 (ID: ${credentialId})`);
            return true;
        } catch (error) {
            console.error(`API 키 삭제 오류:`, error);
            throw error;
        }
    }

    // 사용자의 인증된 거래소 목록 조회 (거래 실행용)
    async getVerifiedExchanges() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT uec.id, uec.exchange_id, e.name as exchange_name, e.type as exchange_type
                FROM user_exchange_credentials uec
                JOIN exchanges e ON uec.exchange_id = e.id
                WHERE uec.user_id = ? AND uec.is_verified = TRUE AND uec.is_active = TRUE
                ORDER BY e.type, e.name
            `, [this.userId]);
            connection.release();

            return rows;
        } catch (error) {
            console.error(`인증된 거래소 조회 오류:`, error);
            throw error;
        }
    }
}

module.exports = ApiKeyService;
