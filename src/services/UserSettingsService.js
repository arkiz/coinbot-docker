const db = require('../config/database');

class UserSettingsService {
    constructor(userId) {
        this.userId = userId;
    }

    // 사용자의 모든 입금주소 조회
    async getAllDepositAddresses() {
        try {
            const connection = await db.getConnection();
            
            // 입금주소 및 메모 설정 조회
            const [settings] = await connection.execute(`
                SELECT us.key_name, us.value, us.updated_at
                FROM user_settings us
                WHERE us.user_id = ? AND us.is_active = TRUE
                  AND (us.key_name LIKE 'deposit_address:%' OR us.key_name LIKE 'deposit_memo:%')
                ORDER BY us.updated_at DESC
            `, [this.userId]);

            // 거래소 및 코인 정보 조회
            const [exchanges] = await connection.execute(`
                SELECT id, name FROM exchanges WHERE is_active = TRUE
            `);
            const [coins] = await connection.execute(`
                SELECT symbol, name FROM coins WHERE is_active = TRUE AND is_tradable = TRUE
            `);
            
            connection.release();

            // 매핑 생성
            const exchangeMap = new Map(exchanges.map(e => [String(e.id), e.name]));
            const coinMap = new Map(coins.map(c => [c.symbol.toUpperCase(), c.name]));

            // 데이터 그룹핑 (exchangeId:symbol 기준)
            const grouped = new Map();
            
            for (const setting of settings) {
                const parts = setting.key_name.split(':');
                if (parts.length !== 3) continue;
                
                const [type, exchangeId, symbol] = parts;
                const key = `${exchangeId}:${symbol.toUpperCase()}`;
                
                if (!grouped.has(key)) {
                    grouped.set(key, {
                        exchangeId: Number(exchangeId),
                        exchangeName: exchangeMap.get(exchangeId) || `거래소 #${exchangeId}`,
                        symbol: symbol.toUpperCase(),
                        coinName: coinMap.get(symbol.toUpperCase()) || '',
                        address: null,
                        memo: null,
                        updated_at: setting.updated_at
                    });
                }
                
                const item = grouped.get(key);
                if (type === 'deposit_address') {
                    item.address = setting.value;
                } else if (type === 'deposit_memo') {
                    item.memo = setting.value;
                }
                
                // 최신 업데이트 시간 유지
                if (setting.updated_at > item.updated_at) {
                    item.updated_at = setting.updated_at;
                }
            }

            return Array.from(grouped.values())
                .sort((a, b) => a.exchangeName.localeCompare(b.exchangeName) || a.symbol.localeCompare(b.symbol));
                
        } catch (error) {
            console.error(`사용자 ${this.userId} 입금주소 조회 오류:`, error);
            throw error;
        }
    }

    // 입금주소 저장/수정
    async upsertDepositAddress(exchangeId, symbol, address, memo = '') {
        if (!exchangeId || !symbol || !address) {
            throw new Error('거래소, 코인, 주소는 필수입니다.');
        }

        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();

            const upperSymbol = symbol.toUpperCase();
            
            // 주소 저장
            await connection.execute(`
                INSERT INTO user_settings (user_id, key_name, value, data_type, description, is_active, updated_at)
                VALUES (?, ?, ?, 'string', ?, TRUE, NOW())
                ON DUPLICATE KEY UPDATE 
                    value = VALUES(value), 
                    updated_at = VALUES(updated_at), 
                    is_active = TRUE
            `, [
                this.userId, 
                `deposit_address:${exchangeId}:${upperSymbol}`, 
                address.trim(),
                `${upperSymbol} 입금주소`
            ]);

            // 메모 저장 (있는 경우)
            if (memo !== undefined) {
                await connection.execute(`
                    INSERT INTO user_settings (user_id, key_name, value, data_type, description, is_active, updated_at)
                    VALUES (?, ?, ?, 'string', ?, TRUE, NOW())
                    ON DUPLICATE KEY UPDATE 
                        value = VALUES(value), 
                        updated_at = VALUES(updated_at), 
                        is_active = TRUE
                `, [
                    this.userId, 
                    `deposit_memo:${exchangeId}:${upperSymbol}`, 
                    memo.trim(),
                    `${upperSymbol} 입금메모`
                ]);
            }

            await connection.commit();
            connection.release();
            
            console.log(`사용자 ${this.userId} 입금주소 저장: ${upperSymbol} → 거래소 ${exchangeId}`);
            return true;
            
        } catch (error) {
            console.error(`입금주소 저장 오류:`, error);
            throw error;
        }
    }

    // 입금주소 삭제
    async deleteDepositAddress(exchangeId, symbol) {
        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();

            const upperSymbol = symbol.toUpperCase();
            
            await connection.execute(`
                DELETE FROM user_settings 
                WHERE user_id = ? AND (key_name = ? OR key_name = ?)
            `, [
                this.userId,
                `deposit_address:${exchangeId}:${upperSymbol}`,
                `deposit_memo:${exchangeId}:${upperSymbol}`
            ]);

            await connection.commit();
            connection.release();
            
            console.log(`사용자 ${this.userId} 입금주소 삭제: ${upperSymbol} → 거래소 ${exchangeId}`);
            return true;
            
        } catch (error) {
            console.error(`입금주소 삭제 오류:`, error);
            throw error;
        }
    }

    // 특정 코인/거래소의 입금주소 조회 (거래 실행 시 사용)
    async getDepositAddress(exchangeId, symbol) {
        try {
            const connection = await db.getConnection();
            const upperSymbol = symbol.toUpperCase();
            
            const [addressRows] = await connection.execute(`
                SELECT value FROM user_settings 
                WHERE user_id = ? AND key_name = ? AND is_active = TRUE
            `, [this.userId, `deposit_address:${exchangeId}:${upperSymbol}`]);
            
            const [memoRows] = await connection.execute(`
                SELECT value FROM user_settings 
                WHERE user_id = ? AND key_name = ? AND is_active = TRUE
            `, [this.userId, `deposit_memo:${exchangeId}:${upperSymbol}`]);
            
            connection.release();

            if (addressRows.length === 0) {
                return null;
            }

            return {
                address: addressRows[0].value,
                memo: memoRows.length > 0 ? memoRows[0].value : null
            };
            
        } catch (error) {
            console.error(`입금주소 조회 오류:`, error);
            throw error;
        }
    }
}

module.exports = UserSettingsService;
