const db = require('../config/database');

class ExchangeManagementService {
    // 모든 거래소 조회
    async getAllExchanges() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT * FROM exchanges 
                ORDER BY type, name
            `);
            connection.release();
            return rows;
        } catch (error) {
            console.error('거래소 목록 조회 오류:', error);
            throw error;
        }
    }

    // 활성 거래소만 조회 (사용자 페이지용)
    async getActiveExchanges() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT * FROM exchanges 
                WHERE is_active = TRUE 
                ORDER BY type, name
            `);
            connection.release();
            return rows;
        } catch (error) {
            console.error('활성 거래소 조회 오류:', error);
            throw error;
        }
    }

    // 거래소 추가
    async createExchange(exchangeData) {
        const { name, type, api_url, websocket_url, trading_fee_rate, withdrawal_fee_rate } = exchangeData;
        
        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();
            
            // 중복 이름 확인
            const [existing] = await connection.execute(
                'SELECT id FROM exchanges WHERE name = ?', 
                [name]
            );
            
            if (existing.length > 0) {
                await connection.rollback();
                connection.release();
                throw new Error('이미 존재하는 거래소 이름입니다.');
            }

            const [result] = await connection.execute(`
                INSERT INTO exchanges (name, type, api_url, websocket_url, trading_fee_rate, withdrawal_fee_rate, is_active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW())
            `, [
                name.trim(),
                type,
                api_url.trim(),
                websocket_url?.trim() || null,
                parseFloat(trading_fee_rate) || 0.0025,
                parseFloat(withdrawal_fee_rate) || 0.001
            ]);

            await connection.commit();
            connection.release();
            
            console.log(`새 거래소 추가: ${name} (ID: ${result.insertId})`);
            return result.insertId;
            
        } catch (error) {
            console.error('거래소 생성 오류:', error);
            throw error;
        }
    }

    // 거래소 수정
    async updateExchange(exchangeId, exchangeData) {
        const { name, type, api_url, websocket_url, trading_fee_rate, withdrawal_fee_rate } = exchangeData;
        
        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();
            
            // 기존 데이터 확인
            const [existing] = await connection.execute('SELECT name FROM exchanges WHERE id = ?', [exchangeId]);
            if (existing.length === 0) {
                await connection.rollback();
                connection.release();
                throw new Error('존재하지 않는 거래소입니다.');
            }

            // 중복 이름 확인 (자기 자신 제외)
            const [duplicate] = await connection.execute(
                'SELECT id FROM exchanges WHERE name = ? AND id != ?', 
                [name, exchangeId]
            );
            
            if (duplicate.length > 0) {
                await connection.rollback();
                connection.release();
                throw new Error('이미 존재하는 거래소 이름입니다.');
            }

            await connection.execute(`
                UPDATE exchanges 
                SET name = ?, type = ?, api_url = ?, websocket_url = ?, 
                    trading_fee_rate = ?, withdrawal_fee_rate = ?
                WHERE id = ?
            `, [
                name.trim(),
                type,
                api_url.trim(),
                websocket_url?.trim() || null,
                parseFloat(trading_fee_rate) || 0.0025,
                parseFloat(withdrawal_fee_rate) || 0.001,
                exchangeId
            ]);

            await connection.commit();
            connection.release();
            
            console.log(`거래소 수정 완료: ${name} (ID: ${exchangeId})`);
            return true;
            
        } catch (error) {
            console.error(`거래소 수정 오류 (ID: ${exchangeId}):`, error);
            throw error;
        }
    }

    // 거래소 활성화/비활성화 토글
    async toggleExchangeStatus(exchangeId) {
        try {
            const connection = await db.getConnection();
            
            const [rows] = await connection.execute(
                'SELECT name, is_active FROM exchanges WHERE id = ?', 
                [exchangeId]
            );
            
            if (rows.length === 0) {
                connection.release();
                throw new Error('존재하지 않는 거래소입니다.');
            }

            const currentStatus = rows[0].is_active;
            const newStatus = !currentStatus;
            
            await connection.execute(
                'UPDATE exchanges SET is_active = ? WHERE id = ?',
                [newStatus, exchangeId]
            );

            connection.release();
            
            console.log(`거래소 상태 변경: ${rows[0].name} → ${newStatus ? '활성' : '비활성'}`);
            return newStatus;
            
        } catch (error) {
            console.error(`거래소 상태 토글 오류 (ID: ${exchangeId}):`, error);
            throw error;
        }
    }

    // 거래소 삭제 (사용 중인 경우 삭제 불가)
    async deleteExchange(exchangeId) {
        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();

            // 사용 중인지 확인
            const [apiKeyUsage] = await connection.execute(`
                SELECT COUNT(*) as count FROM user_exchange_credentials 
                WHERE exchange_id = ?
            `, [exchangeId]);

            if (apiKeyUsage[0].count > 0) {
                await connection.rollback();
                connection.release();
                throw new Error('사용자가 등록한 API 키가 있어 삭제할 수 없습니다.');
            }

            // 거래 내역 확인
            const [tradeUsage] = await connection.execute(`
                SELECT COUNT(*) as count FROM trade_history 
                WHERE buy_exchange_id = ? OR sell_exchange_id = ?
            `, [exchangeId, exchangeId]);

            if (tradeUsage[0].count > 0) {
                await connection.rollback();
                connection.release();
                throw new Error('거래 내역이 있어 삭제할 수 없습니다.');
            }

            // 삭제 실행
            const [result] = await connection.execute('DELETE FROM exchanges WHERE id = ?', [exchangeId]);
            
            if (result.affectedRows === 0) {
                await connection.rollback();
                connection.release();
                throw new Error('삭제할 거래소를 찾을 수 없습니다.');
            }

            await connection.commit();
            connection.release();
            
            console.log(`거래소 삭제 완료 (ID: ${exchangeId})`);
            return true;
            
        } catch (error) {
            console.error(`거래소 삭제 오류 (ID: ${exchangeId}):`, error);
            throw error;
        }
    }

    // 초기 거래소 데이터 생성 (개발/운영 편의용)
    async initializeDefaultExchanges() {
        try {
            const connection = await db.getConnection();
            
            // 기존 데이터 확인
            const [existing] = await connection.execute('SELECT COUNT(*) as count FROM exchanges');
            if (existing[0].count > 0) {
                connection.release();
                console.log('거래소 데이터가 이미 존재합니다.');
                return false;
            }

            // 기본 거래소 데이터 삽입
            const defaultExchanges = [
                {
                    name: '업비트',
                    type: 'domestic',
                    api_url: 'https://api.upbit.com/v1',
                    websocket_url: 'wss://api.upbit.com/websocket/v1',
                    trading_fee_rate: 0.0005,
                    withdrawal_fee_rate: 0.001
                },
                {
                    name: '바이낸스',
                    type: 'overseas',
                    api_url: 'https://api.binance.com/api/v3',
                    websocket_url: 'wss://stream.binance.com:9443/ws',
                    trading_fee_rate: 0.001,
                    withdrawal_fee_rate: 0.001
                },
                {
                    name: '빗썸',
                    type: 'domestic',
                    api_url: 'https://api.bithumb.com',
                    websocket_url: null,
                    trading_fee_rate: 0.0025,
                    withdrawal_fee_rate: 0.001
                }
            ];

            for (const exchange of defaultExchanges) {
                await connection.execute(`
                    INSERT INTO exchanges (name, type, api_url, websocket_url, trading_fee_rate, withdrawal_fee_rate, is_active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW())
                `, [
                    exchange.name,
                    exchange.type,
                    exchange.api_url,
                    exchange.websocket_url,
                    exchange.trading_fee_rate,
                    exchange.withdrawal_fee_rate
                ]);
            }

            connection.release();
            
            console.log(`기본 거래소 ${defaultExchanges.length}개 생성 완료`);
            return true;
            
        } catch (error) {
            console.error('기본 거래소 초기화 오류:', error);
            throw error;
        }
    }
}

module.exports = new ExchangeManagementService();
