// src/services/CoinService.js
const db = require('../config/database');

class CoinService {
    constructor() {
        this.supportedNetworks = ['BTC', 'ERC20', 'TRC20', 'BEP20', 'XRP', 'ADA', 'DOT', 'SOL'];
    }

    // 모든 코인 조회
    async getAllCoins() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    c.*,
                    cu.username as created_by_name,
                    uu.username as updated_by_name
                FROM coins c
                LEFT JOIN users cu ON c.created_by = cu.id
                LEFT JOIN users uu ON c.updated_by = uu.id
                ORDER BY c.symbol ASC
            `);
            connection.release();
            return rows;
        } catch (error) {
            console.error('코인 목록 조회 오류:', error);
            throw error;
        }
    }

    // 특정 코인 조회
    async getCoinById(id) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute('SELECT * FROM coins WHERE id = ?', [id]);
            connection.release();
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error(`코인 ID ${id} 조회 오류:`, error);
            throw error;
        }
    }

    // 코인 추가
    async createCoin(userId, coinData) {
        const { symbol, name, network, upbit_market, binance_symbol, withdrawal_fee, min_withdrawal, description, website_url, is_active, is_tradable } = coinData;
        
        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();

            // 중복 심볼 확인
            const [existing] = await connection.execute('SELECT id FROM coins WHERE symbol = ?', [symbol.toUpperCase()]);
            if (existing.length > 0) {
                await connection.rollback();
                connection.release();
                throw new Error('이미 존재하는 코인 심볼입니다.');
            }

            // 코인 생성
            const [result] = await connection.execute(`
                INSERT INTO coins (symbol, name, network, upbit_market, binance_symbol, withdrawal_fee, min_withdrawal, 
                                 description, website_url, is_active, is_tradable, created_by, updated_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            `, [
                symbol.toUpperCase(), name, network, upbit_market, binance_symbol,
                withdrawal_fee ? parseFloat(withdrawal_fee) : null,
                min_withdrawal ? parseFloat(min_withdrawal) : null,
                description, website_url, is_active, is_tradable, userId, userId
            ]);

            const coinId = result.insertId;

            // 감사 로그 기록
            await this.logChange(connection, coinId, userId, 'CREATE', null, coinData, '새 코인 추가');

            await connection.commit();
            connection.release();

            console.log(`새 코인 추가: ${symbol} (ID: ${coinId}) by user ${userId}`);
            return coinId;
        } catch (error) {
            console.error('코인 생성 오류:', error);
            throw error;
        }
    }

    // 코인 수정
    async updateCoin(userId, coinId, coinData) {
        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();

            // 기존 데이터 조회
            const [oldRows] = await connection.execute('SELECT * FROM coins WHERE id = ?', [coinId]);
            if (oldRows.length === 0) {
                await connection.rollback();
                connection.release();
                throw new Error('코인을 찾을 수 없습니다.');
            }

            const oldCoin = oldRows[0];
            const { symbol, name, network, upbit_market, binance_symbol, withdrawal_fee, min_withdrawal, description, website_url, is_active, is_tradable } = coinData;

            // 코인 업데이트
            await connection.execute(`
                UPDATE coins 
                SET name = ?, network = ?, upbit_market = ?, binance_symbol = ?, withdrawal_fee = ?, 
                    min_withdrawal = ?, description = ?, website_url = ?, is_active = ?, is_tradable = ?, 
                    updated_by = ?, updated_at = NOW()
                WHERE id = ?
            `, [
                name, network, upbit_market, binance_symbol,
                withdrawal_fee ? parseFloat(withdrawal_fee) : null,
                min_withdrawal ? parseFloat(min_withdrawal) : null,
                description, website_url, is_active, is_tradable, userId, coinId
            ]);

            // 변경된 필드들 식별 및 로그 기록
            const changes = this.identifyChanges(oldCoin, coinData);
            if (changes.length > 0) {
                for (const change of changes) {
                    await this.logChange(connection, coinId, userId, 'UPDATE', change.oldValue, change.newValue, `${change.field} 변경`, change.field);
                }
            }

            await connection.commit();
            connection.release();

            console.log(`코인 수정: ${oldCoin.symbol} (ID: ${coinId}) by user ${userId}`);
            return true;
        } catch (error) {
            console.error(`코인 수정 오류 (ID: ${coinId}):`, error);
            throw error;
        }
    }

    // 코인 상태 토글
    async toggleCoinStatus(userId, coinId, field) {
        if (!['is_active', 'is_tradable'].includes(field)) {
            throw new Error('잘못된 상태 필드입니다.');
        }

        try {
            const connection = await db.getConnection();
            await connection.beginTransaction();

            // 기존 상태 조회
            const [rows] = await connection.execute(`SELECT ${field}, symbol FROM coins WHERE id = ?`, [coinId]);
            if (rows.length === 0) {
                await connection.rollback();
                connection.release();
                throw new Error('코인을 찾을 수 없습니다.');
            }

            const oldStatus = rows[0][field];
            const newStatus = !oldStatus;
            const symbol = rows[0].symbol;

            // 상태 토글
            await connection.execute(`UPDATE coins SET ${field} = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`, [newStatus, userId, coinId]);

            // 감사 로그 기록
            const changeReason = field === 'is_active' ? 
                (newStatus ? '모니터링 활성화' : '모니터링 비활성화') :
                (newStatus ? '거래 활성화' : '거래 비활성화');

            await this.logChange(connection, coinId, userId, 'TOGGLE_STATUS', oldStatus, newStatus, changeReason, field);

            await connection.commit();
            connection.release();

            console.log(`코인 상태 변경: ${symbol} ${field} = ${newStatus} by user ${userId}`);
            return true;
        } catch (error) {
            console.error(`코인 상태 토글 오류 (ID: ${coinId}):`, error);
            throw error;
        }
    }

    // 코인 변경 이력 조회
    async getCoinAuditLogs(coinId, limit = 50) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    cal.*,
                    u.username as changed_by_name,
                    c.symbol as coin_symbol
                FROM coin_audit_logs cal
                LEFT JOIN users u ON cal.user_id = u.id
                JOIN coins c ON cal.coin_id = c.id
                WHERE cal.coin_id = ?
                ORDER BY cal.created_at DESC
                LIMIT ${Math.max(1, Math.min(100, parseInt(limit)))}
            `, [coinId]);
            connection.release();
            return rows;
        } catch (error) {
            console.error(`코인 감사 로그 조회 오류 (ID: ${coinId}):`, error);
            throw error;
        }
    }

    // 전체 변경 이력 조회 (관리자 대시보드용)
    async getAllAuditLogs(limit = 20) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    cal.*,
                    u.username as changed_by_name,
                    c.symbol as coin_symbol
                FROM coin_audit_logs cal
                LEFT JOIN users u ON cal.user_id = u.id
                JOIN coins c ON cal.coin_id = c.id
                ORDER BY cal.created_at DESC
                LIMIT ${Math.max(1, Math.min(100, parseInt(limit)))}
            `, []);
            connection.release();
            return rows;
        } catch (error) {
            console.error('전체 감사 로그 조회 오류:', error);
            throw error;
        }
    }

    // 변경 이력 로그 기록 (내부 메서드)
    async logChange(connection, coinId, userId, actionType, oldValue, newValue, reason, fieldName = null) {
        try {
            await connection.execute(`
                INSERT INTO coin_audit_logs (coin_id, user_id, action_type, field_name, old_value, new_value, change_reason, change_source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMIN_WEB', NOW())
            `, [
                coinId, userId, actionType, fieldName,
                oldValue !== null && oldValue !== undefined ? String(oldValue) : null,
                newValue !== null && newValue !== undefined ? String(newValue) : null,
                reason
            ]);
        } catch (error) {
            console.error('변경 로그 기록 실패:', error);
            // 로그 기록 실패는 전체 트랜잭션을 실패시키지 않음
        }
    }

    // 변경된 필드 식별 (내부 메서드)
    identifyChanges(oldCoin, newData) {
        const changes = [];
        const fieldsToCheck = ['name', 'network', 'upbit_market', 'binance_symbol', 'withdrawal_fee', 'min_withdrawal', 'description', 'website_url', 'is_active', 'is_tradable'];

        fieldsToCheck.forEach(field => {
            if (newData[field] !== undefined && newData[field] !== oldCoin[field]) {
                changes.push({
                    field: field,
                    oldValue: oldCoin[field],
                    newValue: newData[field]
                });
            }
        });

        return changes;
    }

    // 거래소 API에서 코인 정보 가져오기 (향후 확장용)
    async fetchCoinInfoFromAPI(symbol) {
        // 현재는 기본 구조만 제공
        // 실제 구현 시 BinanceService, UpbitService 활용
        try {
            console.log(`API에서 ${symbol} 정보 조회 (구현 예정)`);
            return {
                withdrawal_fee: null,
                min_withdrawal: null,
                status: 'not_implemented',
                message: 'API 연동 기능은 향후 구현 예정'
            };
        } catch (error) {
            console.error(`${symbol} API 정보 조회 실패:`, error);
            throw error;
        }
    }
}

module.exports = new CoinService();
