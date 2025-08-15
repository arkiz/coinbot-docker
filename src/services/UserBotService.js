// services/UserBotService.js
const db = require('../config/database');
const ExchangeService = require('./ExchangeService');
const ApiKeyService = require('./ApiKeyService');

class UserBotService {
    constructor(userId) {
        this.userId = userId;
        
    }

    async getBotSettings() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(
                `SELECT key_name, value, data_type 
                    FROM bot_settings 
                    WHERE user_id = ?`,
                [this.userId]
            );
            connection.release();
            
            const savedSettings  = {};
            rows.forEach(row => {
                let parsedValue = row.value;
                
                if (row.data_type === 'number') {
                    parsedValue = parseFloat(row.value);
                } else if (row.data_type === 'boolean') {
                    parsedValue = row.value === 'true';
                } else if (row.data_type === 'json') {
                    try {
                        parsedValue = JSON.parse(row.value);
                    } catch (e) {
                        parsedValue = row.value;
                    }
                }
                
                savedSettings[row.key_name] = parsedValue;
            });

            const requiredSettings = [
                'search_interval_seconds',
                'premium_threshold_percent', 
                'trading_intensity_threshold',
                'min_trade_amount_krw',
                'max_trade_amount_krw'
            ];

            const hasAllSettings = requiredSettings.every(key => savedSettings.hasOwnProperty(key));
            const settingsCount = Object.keys(savedSettings).length;

            // console.log(`hasAllSettings`, hasAllSettings)
            return {
                // ✅ 설정 상태 정보
                hasSettings: hasAllSettings,
                isComplete: hasAllSettings,
                settingsCount: settingsCount,
                totalRequired: requiredSettings.length,
                
                // ✅ 실제 설정값 (없으면 null)
                search_interval_seconds: savedSettings.search_interval_seconds || null,
                premium_threshold_percent: savedSettings.premium_threshold_percent || null,
                trading_intensity_threshold: savedSettings.trading_intensity_threshold || null,
                min_trade_amount_krw: savedSettings.min_trade_amount_krw || null,
                max_trade_amount_krw: savedSettings.max_trade_amount_krw || null,
                bot_enabled: savedSettings.bot_enabled || false,
                
                // ✅ 권장 기본값 (UI에서 사용)
                defaults: {
                    search_interval_seconds: 60,
                    premium_threshold_percent: 1.0,
                    trading_intensity_threshold: 5,
                    min_trade_amount_krw: 1000000,
                    max_trade_amount_krw: 10000000,
                    bot_enabled: false
                }
            };
        } catch (error) {
            console.error(`사용자 ${this.userId} 설정 조회 오류:`, error);
            throw error;
        }
    }

    async createInitialSettings() {
        try {
            const defaultSettings = {
                search_interval_seconds: 60,
                premium_threshold_percent: 1.0,
                trading_intensity_threshold: 5,
                min_trade_amount_krw: 1000000,
                max_trade_amount_krw: 10000000,
                bot_enabled: false
            };

            await this.updateBotSettings(defaultSettings);
            console.log(`사용자 ${this.userId} 초기 설정 생성 완료`);
            return true;
        } catch (error) {
            console.error(`사용자 ${this.userId} 초기 설정 생성 오류:`, error);
            throw error;
        }
    }



    async updateBotSettings(newSettings) {
        try {

            const connection = await db.getConnection();

            const settingsToUpdate = [
                'search_interval_seconds',
                'premium_threshold_percent', 
                'trading_intensity_threshold',
                'min_trade_amount_krw',
                'max_trade_amount_krw',
                'bot_enabled'
            ];

            for (const key of settingsToUpdate) {
                if (newSettings[key] !== undefined) {

                    let valueToSave = newSettings[key];
                    const dataType = this.getDataType(key);
                    const description = this.getSettingDescription(key);

                    // ✅ 타입별 값 처리
                    if (dataType === 'boolean') {
                        // HTML 폼에서 올 수 있는 다양한 boolean 값 처리
                        valueToSave = (valueToSave === true || valueToSave === 'true' || valueToSave === 'on');
                    } else if (dataType === 'number') {
                        valueToSave = parseFloat(valueToSave);
                        // NaN 체크
                        if (isNaN(valueToSave)) {
                            console.warn(`Invalid number value for ${key}: ${newSettings[key]}`);
                            continue;
                        }
                    }

                    await connection.execute(`
                        INSERT INTO bot_settings (user_id, key_name, value, data_type, description, is_active, updated_at)
                        VALUES (?, ?, ?, ?, ?, TRUE, NOW())
                        ON DUPLICATE KEY UPDATE 
                            value = VALUES(value),
                            updated_at = VALUES(updated_at)
                    `, [this.userId, key, valueToSave.toString(), dataType, description]);
                }
            }

            connection.release();
            console.log(`사용자 ${this.userId} 설정 업데이트 완료`);
            return true;
        } catch (error) {
            console.error(`사용자 ${this.userId} 설정 업데이트 오류:`, error);
            throw error;
        }
    }

    async getExchangeBalances() {
        try {
            const apiKeyService = new ApiKeyService(this.userId);
            const verifiedExchanges = await apiKeyService.getVerifiedExchanges();
            
            const balances = { domestic: [], overseas: [] };

            for (const exchange of verifiedExchanges) {
                try {
                    // 복호화된 키 가져오기
                    const decryptedKeys = await apiKeyService.getDecryptedApiKey(exchange.id);
                    const balance = await ExchangeService.getBalance(
                        exchange.exchange_id,
                        decryptedKeys.api_key,
                        decryptedKeys.secret_key,
                        decryptedKeys.passphrase
                    );
                    
                    const balanceInfo = {
                        exchangeName: exchange.exchange_name,
                        balance: balance,
                        isVerified: true
                    };

                    if (exchange.exchange_type === 'domestic') {
                        balances.domestic.push(balanceInfo);
                    } else {
                        balances.overseas.push(balanceInfo);
                    }
                } catch (error) {
                    console.error(`잔고 조회 실패 (${exchange.exchange_name}):`, error);
                    // 실패한 경우에도 기본 정보는 표시
                    const balanceInfo = {
                        exchangeName: exchange.exchange_name,
                        balance: null,
                        error: error.message,
                        isVerified: false
                    };

                    if (exchange.exchange_type === 'domestic') {
                        balances.domestic.push(balanceInfo);
                    } else {
                        balances.overseas.push(balanceInfo);
                    }
                }
            }

            return balances;
        } catch (error) {
            console.error(`사용자 ${this.userId} 잔고 조회 오류:`, error);
            return { domestic: [], overseas: [] };
        }
    }

    async startBot() {
        const connection = await db.getConnection();
        await connection.execute(`
            INSERT INTO bot_settings (user_id, key_name, value, data_type)
            VALUES (?, 'bot_enabled', 'true', 'boolean')
            ON DUPLICATE KEY UPDATE value = 'true'
        `, [this.userId]);
    }

    async stopBot() {
        const connection = await db.getConnection();
        await connection.execute(`
            INSERT INTO bot_settings (user_id, key_name, value, data_type)
            VALUES (?, 'bot_enabled', 'false', 'boolean')
            ON DUPLICATE KEY UPDATE value = 'false'
        `, [this.userId]);
    }

    async getTradingIntensity() {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    ti.coin_id,
                    c.symbol,
                    c.name,
                    ti.current_intensity,
                    ti.last_premium_rate,
                    ti.last_updated
                FROM trading_intensity ti
                JOIN coins c ON ti.coin_id = c.id
                WHERE ti.user_id = ?
                ORDER BY ti.current_intensity DESC, ti.last_updated DESC
            `, [this.userId]);
            connection.release();

            return rows;
        } catch (error) {
            console.error(`사용자 ${this.userId} 매매강도 조회 오류:`, error);
            throw error;
        }
    }

    async getTradeHistory(limit = 20) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    th.*,
                    c.symbol as coin_symbol,
                    c.name as coin_name,
                    be.name as buy_exchange_name,
                    se.name as sell_exchange_name
                FROM trade_history th
                JOIN coins c ON th.coin_id = c.id
                JOIN exchanges be ON th.buy_exchange_id = be.id
                JOIN exchanges se ON th.sell_exchange_id = se.id
                WHERE th.user_id = ?
                ORDER BY th.created_at DESC
                LIMIT ${limit}
            `, [this.userId]);
            connection.release();

            return rows;
        } catch (error) {
            console.error(`사용자 ${this.userId} 거래 내역 조회 오류:`, error);
            throw error;
        }
    }

    getDataType(key) {
        const numberFields = ['search_interval_seconds', 'trading_intensity_threshold', 'min_trade_amount_krw', 'max_trade_amount_krw', 'premium_threshold_percent'];
        const booleanFields = ['bot_enabled'];
        
        if (numberFields.includes(key)) return 'number';
        if (booleanFields.includes(key)) return 'boolean';
        return 'string';
    }

    getSettingDescription(key) {
        const descriptions = {
            'search_interval_seconds': '가격 검색 주기(초)',
            'premium_threshold_percent': '프리미엄 임계값(%)',
            'trading_intensity_threshold': '매수 조건 임계값',
            'min_trade_amount_krw': '최소 거래 금액(원)',
            'max_trade_amount_krw': '최대 거래 금액(원)',
            'bot_enabled': '봇 활성화 상태'
        };
        return descriptions[key] || '';
    }
}

module.exports = UserBotService;