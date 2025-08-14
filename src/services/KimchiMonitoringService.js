const winston = require('winston');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

/**
 * 김프 차익거래 모니터링 서비스 - 시스템의 핵심 엔진
 * 
 * 주요 책임:
 * 1. 60초 주기로 5개 코인의 김프 계산
 * 2. 호가창 5틱 기반 정확한 평균가 산출
 * 3. 매매강도 시스템 (기획서 로직 구현)
 * 4. 거래 기회 발생 시 알림 및 로깅
 * 
 * 데이터 흐름:
 * 거래소 API → 김프 계산 → 매매강도 업데이트 → 캐싱/저장 → 거래 신호
 */
class KimchiMonitoringService {
    constructor(upbitService, binanceService, exchangeRateService) {
        this.upbitService = upbitService;
        this.binanceService = binanceService;
        this.exchangeRateService = exchangeRateService;
        this.isRunning = false;
        this.monitoringInterval = null;
        
        // 로거 설정
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level.toUpperCase()}] [KimchiMonitor] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ 
                    filename: '../logs/kimchi-monitor.log',
                    level: 'info'
                })
            ]
        });

        // 데이터베이스 연결 설정
        this.dbConfig = {
            host: process.env.DB_HOST || 'mysql',
            user: process.env.DB_USER || 'coinbot',
            password: process.env.DB_PASSWORD || 'coinbot123',
            database: process.env.DB_NAME || 'coinbot_dev',
            charset: 'utf8mb4'
        };

        // Redis 연결
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: process.env.REDIS_PORT || 6379
        });

        // 기본 설정값
        this.settings = {
            searchIntervalSeconds: 60,
            premiumThresholdPercent: 1.0,
            tradingIntensityThreshold: 5
        };

        // 모니터링할 코인 목록 
        // TODO - load from DB(table design require)
        this.coinMappings = [
            { symbol: 'BTC', upbitMarket: 'KRW-BTC', binanceSymbol: 'BTCUSDT' },
            { symbol: 'ETH', upbitMarket: 'KRW-ETH', binanceSymbol: 'ETHUSDT' },
            { symbol: 'XRP', upbitMarket: 'KRW-XRP', binanceSymbol: 'XRPUSDT' },
            { symbol: 'ADA', upbitMarket: 'KRW-ADA', binanceSymbol: 'ADAUSDT' },
            { symbol: 'DOT', upbitMarket: 'KRW-DOT', binanceSymbol: 'DOTUSDT' }
        ];

        // 다중 사용자 지원을 위한 최소한의 새 속성 추가
        this.globalMode = true; // 관리자용 전역 모니터링 활성화
    }

    // 설정값을 데이터베이스에서 로드
    async loadSettings() {
        try {
            const connection = await mysql.createConnection(this.dbConfig);
            const [rows] = await connection.execute(
                `SELECT key_name, value 
                    FROM bot_settings 
                    WHERE is_active = TRUE
                        AND user_id IS NULL`
            );
            await connection.end();

            rows.forEach(row => {
                const { key_name, value } = row;
                
                if (key_name === 'search_interval_seconds') {
                    this.settings.searchIntervalSeconds = parseInt(value);
                } else if (key_name === 'premium_threshold_percent') {
                    this.settings.premiumThresholdPercent = parseFloat(value);
                } else if (key_name === 'trading_intensity_threshold') {
                    this.settings.tradingIntensityThreshold = parseInt(value);
                }
            });

            this.logger.info('봇 설정 로드 완료', this.settings);
        } catch (error) {
            this.logger.error('봇 설정 로드 실패, 기본값 사용', { error: error.message });
        }
    }

    // 단일 코인의 김프 계산 
    async calculateCoinPremium(coinMapping) {
        try {
            const startTime = Date.now();
            
            // 병렬로 데이터 수집
            const [upbitTicker, upbitOrderbook, binanceTicker, binanceOrderbook, exchangeRate] = await Promise.all([
                this.upbitService.getTicker(coinMapping.upbitMarket),
                this.upbitService.getOrderbook(coinMapping.upbitMarket, 5),
                this.binanceService.getTicker(coinMapping.binanceSymbol),
                this.binanceService.getOrderbook(coinMapping.binanceSymbol, 5),
                this.exchangeRateService.getUsdKrwRate()
            ]);

            // 호가창 5틱 평균가 계산 
            const upbitAskAvg = this.upbitService.calculateAveragePrice(upbitOrderbook, 'ask');
            const upbitBidAvg = this.upbitService.calculateAveragePrice(upbitOrderbook, 'bid');
            const binanceAskAvg = this.binanceService.calculateAveragePrice(binanceOrderbook, 'ask');
            const binanceBidAvg = this.binanceService.calculateAveragePrice(binanceOrderbook, 'bid');

            // 김프 계산 (매도호가 기준 - 기획서: 싼 곳에서 사서 비싼 곳에서 판매)
            const upbitSellPrice = upbitAskAvg.averagePrice;  // 업비트에서 매도할 가격
            const binanceBuyPriceKrw = binanceAskAvg.averagePrice * exchangeRate.rate;  // 바이낸스에서 매수할 가격(원화)
            const premium = ((upbitSellPrice - binanceBuyPriceKrw) / binanceBuyPriceKrw) * 100;

            const result = {
                symbol: coinMapping.symbol,
                timestamp: new Date(),
                responseTime: Date.now() - startTime,
                
                // 업비트 데이터
                upbit: {
                    ticker: upbitTicker,
                    askAverage: upbitAskAvg,
                    bidAverage: upbitBidAvg
                },
                
                // 바이낸스 데이터  
                binance: {
                    ticker: binanceTicker,
                    askAverage: binanceAskAvg,
                    bidAverage: binanceBidAvg
                },
                
                // 환율 정보
                exchangeRate: exchangeRate,
                
                // 김프 계산 결과
                premium: {
                    upbitSellPrice,
                    binanceBuyPriceKrw,
                    premiumPercent: premium,
                    isPositive: premium > 0,
                    calculation: `((${upbitSellPrice} - ${Math.round(binanceBuyPriceKrw)}) / ${Math.round(binanceBuyPriceKrw)}) * 100 = ${premium.toFixed(4)}%`
                }
            };

            // Redis에 최신 데이터 저장 (TTL 5분)
            await this.redis.setex(
                `premium:${coinMapping.symbol}:latest`, 
                300, 
                JSON.stringify(result)
            );

            this.logger.debug(`${coinMapping.symbol} 김프 계산 완료`, {
                symbol: coinMapping.symbol,
                premium: premium.toFixed(4),
                responseTime: result.responseTime
            });

            return result;

        } catch (error) {
            this.logger.error(`${coinMapping.symbol} 김프 계산 실패`, { 
                error: error.message,
                symbol: coinMapping.symbol 
            });
            return null;
        }
    }

    // 매매강도 업데이트 (기획서 로직: 0.5% 이상이면 +1, 미만이면 -1, 최저 0)
    async updateTradingIntensity(symbol, premiumPercent) {
        try {
            const connection = await mysql.createConnection(this.dbConfig);
            
            // 전역 매매강도 조회 (user_id IS NULL)
            const [rows] = await connection.execute(
                `SELECT ti.current_intensity 
                    FROM trading_intensity ti 
                        JOIN coins c 
                            ON ti.coin_id = c.id 
                    WHERE c.symbol = ? 
                        AND ti.user_id IS NULL`,
                [symbol]
            );

            let currentIntensity = rows.length > 0 ? rows[0].current_intensity : 0;
            let newIntensity = currentIntensity;

            // 매매강도 계산 
            if (Math.abs(premiumPercent) >= this.settings.premiumThresholdPercent) {
                newIntensity = currentIntensity + 1;
                this.logger.debug(`${symbol} 매매강도 증가`, { 
                    premium: premiumPercent.toFixed(4), 
                    intensity: `${currentIntensity} → ${newIntensity}` 
                });
            } else {
                newIntensity = Math.max(currentIntensity - 1, 0); // 최저 0
                this.logger.debug(`${symbol} 매매강도 감소`, { 
                    premium: premiumPercent.toFixed(4), 
                    intensity: `${currentIntensity} → ${newIntensity}` 
                });
            }

            // 매매강도 업데이트
            if (newIntensity !== currentIntensity) {
                await connection.execute(
                    `UPDATE trading_intensity ti 
                        JOIN coins c 
                            ON ti.coin_id = c.id 
                     SET 
                        ti.current_intensity = ?, 
                        ti.last_premium_rate = ?, 
                        ti.last_updated = NOW() 
                     WHERE c.symbol = ? 
                        AND ti.user_id IS NULL`,
                    [newIntensity, premiumPercent, symbol]
                );

                // Redis에도 저장
                await this.redis.setex(`intensity:${symbol}`, 300, newIntensity.toString());
            }

            await connection.end();

            // 매수 조건 체크 (매매강도가 5가 되었을 때)
            if (newIntensity >= this.settings.tradingIntensityThreshold) {
                this.logger.warn(`🚨 ${symbol} 매수 조건 달성!`, {
                    symbol,
                    intensity: newIntensity,
                    threshold: this.settings.tradingIntensityThreshold,
                    premium: premiumPercent.toFixed(4)
                });

                // 거래 기회 알림 (향후 실제 거래 로직 연결 지점)
                await this.notifyTradingOpportunity(symbol, premiumPercent, newIntensity);
            }

            return {
                symbol,
                previousIntensity: currentIntensity,
                currentIntensity: newIntensity,
                premiumPercent,
                tradingSignal: newIntensity >= this.settings.tradingIntensityThreshold
            };

        } catch (error) {
            this.logger.error(`${symbol} 매매강도 업데이트 실패`, { error: error.message });
            return null;
        }
    }

    // 사용자별 매매강도 업데이트 (새로운 기능 - 기존 로직 재사용)
    async updateUserTradingIntensity(userId, symbol, premiumPercent, userThreshold) {
        try {

            const connection = await mysql.createConnection(this.dbConfig);
            
            // 사용자별 매매강도 조회
            const [rows] = await connection.execute(
                'SELECT ti.current_intensity FROM trading_intensity ti JOIN coins c ON ti.coin_id = c.id WHERE c.symbol = ? AND ti.user_id = ?',
                [symbol, userId]
            );

            let currentIntensity = rows.length > 0 ? rows[0].current_intensity : 0;
            let newIntensity = currentIntensity;

            

            // 기존과 동일한 매매강도 계산 로직 적용
            if (Math.abs(premiumPercent) >= userThreshold) {
                newIntensity = currentIntensity + 1;
            } else {
                newIntensity = Math.max(currentIntensity - 1, 0);
            }

            // console.log(`updateUserTradingIntensity`, 
            //     {
            //         currentIntensity:currentIntensity,
            //         newIntensity:newIntensity,
            //         userThreshold:userThreshold,
            //         premiumPercent:premiumPercent,
            //         symbol:symbol,
            //         userId:userId,
            //     });

            // 사용자별 매매강도 업데이트
            if (newIntensity !== currentIntensity) {
                const [coinRows] = await connection.execute('SELECT id FROM coins WHERE symbol = ?', [symbol]);
                if (coinRows.length > 0) {
                    await connection.execute(
                        `INSERT INTO trading_intensity (user_id, coin_id, current_intensity, last_premium_rate, last_updated)
                         VALUES (?, ?, ?, ?, NOW())
                         ON DUPLICATE KEY UPDATE 
                         current_intensity = VALUES(current_intensity), 
                         last_premium_rate = VALUES(last_premium_rate), 
                         last_updated = VALUES(last_updated)`,
                        [userId, coinRows[0].id, newIntensity, premiumPercent]
                    );

                    await this.redis.setex(`intensity:user:${userId}:${symbol}`, 300, newIntensity.toString());
                }
            }

            await connection.end();
            return { userId, symbol, currentIntensity: newIntensity, premiumPercent };

        } catch (error) {
            this.logger.error(`사용자 ${userId} ${symbol} 매매강도 업데이트 실패`, { error: error.message });
            return null;
        }
    }

    // 거래 기회 알림 (향후 실제 거래 로직 연결 지점)
    async notifyTradingOpportunity(symbol, premiumPercent, intensity) {
        const opportunity = {
            symbol,
            premiumPercent: premiumPercent.toFixed(4),
            intensity,
            timestamp: new Date().toISOString(),
            action: 'TRADING_SIGNAL_TRIGGERED'
        };

        // Redis에 거래 기회 저장
        await this.redis.lpush('trading_opportunities', JSON.stringify(opportunity));
        await this.redis.ltrim('trading_opportunities', 0, 99); // 최근 100개만 유지

        this.logger.warn('🚨 거래 기회 발생!', opportunity);
    }

    // 활성 사용자 봇 조회 (새로운 기능)
    async getActiveUserBots() {
        try {
            const connection = await mysql.createConnection(this.dbConfig);
            const [users] = await connection.execute(`
                SELECT DISTINCT u.id, u.username
                FROM users u
                    JOIN bot_settings bs 
                        ON u.id = bs.user_id
                WHERE u.is_active = TRUE 
                    AND u.role = 'user'
                    AND bs.key_name = 'bot_enabled' 
                    AND bs.value = 'true'
            `);
            await connection.end();
            return users;
        } catch (error) {
            this.logger.error('활성 사용자 봇 조회 실패', { error: error.message });
            return [];
        }
    }

    // 사용자별 설정 로드 (새로운 기능)
    async getUserSettings(userId) {
        try {
            const connection = await mysql.createConnection(this.dbConfig);
            const [rows] = await connection.execute(
                'SELECT key_name, value FROM bot_settings WHERE user_id = ?',
                [userId]
            );
            await connection.end();

            const settings = {
                premiumThresholdPercent: 1.0,
                tradingIntensityThreshold: 5,
                minTradeAmountKrw: 1000000,
                maxTradeAmountKrw: 10000000
            };

            rows.forEach(row => {
                if (row.key_name === 'premium_threshold_percent') {
                    settings.premiumThresholdPercent = parseFloat(row.value);
                } else if (row.key_name === 'trading_intensity_threshold') {
                    settings.tradingIntensityThreshold = parseInt(row.value);
                } else if (row.key_name === 'min_trade_amount_krw') {
                    settings.minTradeAmountKrw = parseInt(row.value);
                } else if (row.key_name === 'max_trade_amount_krw') {
                    settings.maxTradeAmountKrw = parseInt(row.value);
                }
            });

            return settings;
        } catch (error) {
            this.logger.error(`사용자 ${userId} 설정 로드 실패`, { error: error.message });
            return null;
        }
    }

    // 모든 코인 모니터링 실행 (기획서: 지정된 시간마다 실행)
    async monitorAllCoins() {
        try {
            const startTime = Date.now();
            this.logger.info('김프 모니터링 시작', { 
                coins: this.coinMappings.length,
                interval: this.settings.searchIntervalSeconds 
            });

            // 모든 코인 병렬 처리
            const results = await Promise.allSettled(
                this.coinMappings.map(coin => this.calculateCoinPremium(coin))
            );

            const successful = [];
            const failed = [];

            // 결과 처리 및 매매강도 업데이트
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const coinMapping = this.coinMappings[i];

                if (result.status === 'fulfilled' && result.value) {
                    successful.push(result.value);
                    
                    // 매매강도 업데이트
                    const premium = result.value.premium.premiumPercent;
                    await this.updateTradingIntensity(coinMapping.symbol, premium);
                } else {
                    failed.push(coinMapping.symbol);
                }
            }

            // 사용자별 처리 추가
            const activeUsers = await this.getActiveUserBots();
            if (activeUsers.length > 0) {
                this.logger.info(`활성 사용자 봇: ${activeUsers.length}개`);
                
                for (const user of activeUsers) {
                    const userSettings = await this.getUserSettings(user.id);
                    if (userSettings) {
                        for (const result of successful) {
                            await this.updateUserTradingIntensity(
                                user.id, 
                                result.symbol, 
                                result.premium.premiumPercent, 
                                userSettings.premiumThresholdPercent
                            );
                        }
                    }
                }
            }

            const totalTime = Date.now() - startTime;
            
            // 모니터링 결과 요약
            const summary = {
                timestamp: new Date().toISOString(),
                totalCoins: this.coinMappings.length,
                successful: successful.length,
                failed: failed.length,
                totalTime,
                averageTime: successful.length > 0 ? totalTime / successful.length : 0,
                premiums: successful.map(r => ({
                    symbol: r.symbol,
                    premium: r.premium.premiumPercent.toFixed(4),
                    isPositive: r.premium.isPositive
                }))
            };

            // Redis에 모니터링 결과 저장
            await this.redis.setex('monitoring:latest', 300, JSON.stringify(summary));

            this.logger.info('김프 모니터링 완료', summary);

            return summary;

        } catch (error) {
            this.logger.error('김프 모니터링 실패', { error: error.message });
            throw error;
        }
    }

    // 모니터링 시작
    async startMonitoring() {
        if (this.isRunning) {
            this.logger.warn('모니터링이 이미 실행 중입니다.');
            return false;
        }

        try {
            // 설정 로드
            await this.loadSettings();
            
            this.isRunning = true;
            this.logger.info('김프 모니터링 시작', { 
                interval: this.settings.searchIntervalSeconds,
                coins: this.coinMappings.length
            });

            // 즉시 한 번 실행
            await this.monitorAllCoins();

            // 주기적 실행 설정 (기획서: 검색주기마다)
            this.monitoringInterval = setInterval(async () => {
                if (this.isRunning) {
                    await this.monitorAllCoins();
                }
            }, this.settings.searchIntervalSeconds * 1000);

            return true;
        } catch (error) {
            this.logger.error('모니터링 시작 실패', { error: error.message });
            this.isRunning = false;
            return false;
        }
    }

    // 모니터링 중지
    stopMonitoring() {
        if (!this.isRunning) {
            this.logger.warn('모니터링이 실행 중이 아닙니다.');
            return false;
        }

        this.isRunning = false;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }

        this.logger.info('김프 모니터링 중지');
        return true;
    }

    // 현재 상태 조회
    async getStatus() {
        const activeUsers = await this.getActiveUserBots();
        
        return {
            isRunning: this.isRunning,
            settings: this.settings,
            coinCount: this.coinMappings.length,
            coins: this.coinMappings.map(c => c.symbol),
            activeUsers: activeUsers.length,
            nextExecution: this.isRunning ? 
                new Date(Date.now() + this.settings.searchIntervalSeconds * 1000).toISOString() : 
                null
        };
    }

    // 최근 모니터링 결과 조회
    async getLatestResults() {
        try {
            const latestSummary = await this.redis.get('monitoring:latest');
            const results = [];

            for (const coin of this.coinMappings) {
                const data = await this.redis.get(`premium:${coin.symbol}:latest`);
                if (data) {
                    results.push(JSON.parse(data));
                }
            }

            // 매매강도 정보도 포함
            const connection = await mysql.createConnection(this.dbConfig);
            const [intensityRows] = await connection.execute(
                `SELECT c.symbol, ti.current_intensity, ti.last_premium_rate, ti.last_updated 
                 FROM trading_intensity ti 
                 JOIN coins c ON ti.coin_id = c.id 
                 WHERE c.symbol IN (${this.coinMappings.map(() => '?').join(',')}) AND ti.user_id IS NULL`,
                this.coinMappings.map(c => c.symbol)
            );
            await connection.end();

            const processedIntensities = intensityRows.map(row => ({
                ...row,
                current_intensity: parseInt(row.current_intensity) || 0,
                last_premium_rate: parseFloat(row.last_premium_rate) || 0
            }));

            return {
                summary: latestSummary ? JSON.parse(latestSummary) : null,
                coinResults: results,
                tradingIntensities: processedIntensities
            };
        } catch (error) {
            this.logger.error('최근 결과 조회 실패', { error: error.message });
            return null;
        }
    }

    // 사용자별 결과 조회
    async getUserLatestResults(userId) {
        try {
            const connection = await mysql.createConnection(this.dbConfig);
            const [intensityRows] = await connection.execute(
                `SELECT c.symbol, ti.current_intensity, ti.last_premium_rate, ti.last_updated 
                 FROM trading_intensity ti 
                 JOIN coins c ON ti.coin_id = c.id 
                 WHERE c.symbol IN (${this.coinMappings.map(() => '?').join(',')}) AND ti.user_id = ?`,
                [...this.coinMappings.map(c => c.symbol), userId]
            );
            await connection.end();

            return {
                userId,
                tradingIntensities: intensityRows.map(row => ({
                    ...row,
                    current_intensity: parseInt(row.current_intensity) || 0,
                    last_premium_rate: parseFloat(row.last_premium_rate) || 0
                }))
            };
        } catch (error) {
            this.logger.error(`사용자 ${userId} 최근 결과 조회 실패`, { error: error.message });
            return null;
        }
    }
}

module.exports = KimchiMonitoringService;