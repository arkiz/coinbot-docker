const db = require('../config/database');
const Redis = require('ioredis');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

// 필요한 서비스들
const ApiKeyService = require('./ApiKeyService');
const UserSettingsService = require('./UserSettingsService');
const ExchangeRateService = require('./ExchangeRateService');
const UpbitService = require('./UpbitService');
const BinanceService = require('./BinanceService');

class TradeExecutionService {
    constructor() {
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: process.env.REDIS_PORT || 6379
        });

        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level.toUpperCase()}] [TradeExecution] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ 
                    filename: '../logs/trade-execution.log',
                    level: 'info'
                })
            ]
        });

        // 거래소 서비스 인스턴스
        this.upbitService = new UpbitService();
        this.binanceService = new BinanceService();
        this.exchangeRateService = new ExchangeRateService();
    }

    /**
     * 단일 거래 실행 (드라이런/실거래 통합)
     * @param {number} userId - 사용자 ID
     * @param {string} symbol - 코인 심볼
     * @param {number} budgetKrw - 거래 예산 (원화)
     * @param {boolean} dryRun - 드라이런 모드 여부
     */
    async executeOnce(userId, symbol, budgetKrw, dryRun = true) {
        const lockKey = `lock:trade:${userId}:${symbol}`;
        const lockToken = uuidv4();
        let tradeId = null;

        try {
            // 1. 분산 락 획득 (중복 실행 방지)
            const lockAcquired = await this.redis.set(lockKey, lockToken, 'EX', 300, 'NX');
            if (!lockAcquired) {
                throw new Error(`${symbol} 거래가 이미 진행 중입니다`);
            }

            this.logger.info(`거래 실행 시작`, { 
                userId, symbol, budgetKrw, dryRun,
                mode: dryRun ? 'DRY_RUN' : 'LIVE_TRADE'
            });

            // 2. 거래 조건 검증
            const validation = await this.validateTradeConditions(userId, symbol, budgetKrw);
            if (!validation.valid) {
                throw new Error(validation.error);
            }

            // 3. 거래 내역 생성 (pending 상태)
            tradeId = await this.createTradeRecord(userId, validation.data.coin.id, dryRun);

            // 4. 시장 데이터 수집 및 분석
            const marketAnalysis = await this.analyzeMarket(symbol, validation.data.coin);
            
            // 5. 거래 방향 및 수량 결정
            const tradeParams = await this.calculateTradeParameters(
                budgetKrw, 
                marketAnalysis, 
                validation.data.settings
            );

            // 6. 거래 실행
            const executionResult = await this.executeTradeCycle(
                tradeId, 
                userId, 
                symbol,
                tradeParams, 
                validation.data, 
                dryRun
            );

            // 7. 최종 결과 기록
            await this.finalizeTradeRecord(tradeId, executionResult);

            this.logger.info(`거래 실행 완료`, {
                tradeId, symbol, 
                success: executionResult.success,
                netProfit: executionResult.netProfit,
                profitRate: `${executionResult.profitRate.toFixed(4)}%`,
                mode: dryRun ? 'DRY_RUN' : 'LIVE_TRADE'
            });

            return {
                success: executionResult.success,
                tradeId: tradeId,
                symbol: symbol,
                netProfit: executionResult.netProfit,
                profitRate: executionResult.profitRate,
                dryRun: dryRun,
                message: executionResult.success ? 
                    `${symbol} 거래 ${dryRun ? '시뮬레이션' : '실행'} 성공` : 
                    `거래 실패: ${executionResult.error}`
            };

        } catch (error) {
            this.logger.error(`거래 실행 실패`, { 
                userId, symbol, budgetKrw, dryRun, 
                error: error.message,
                tradeId
            });

            if (tradeId) {
                await this.markTradeFailed(tradeId, error.message);
            }

            return {
                success: false,
                tradeId: tradeId,
                symbol: symbol,
                error: error.message,
                dryRun: dryRun
            };

        } finally {
            // 락 해제 (토큰 검증 후)
            const currentToken = await this.redis.get(lockKey);
            if (currentToken === lockToken) {
                await this.redis.del(lockKey);
            }
        }
    }

    /**
     * 거래 조건 검증
     */
    async validateTradeConditions(userId, symbol, budgetKrw) {
        try {
            const connection = await db.getConnection();

            // 사용자 봇 설정 확인
            const [settingsRows] = await connection.execute(`
                SELECT key_name, value, data_type FROM bot_settings 
                WHERE user_id = ? AND is_active = TRUE
            `, [userId]);

            const settings = {};
            settingsRows.forEach(row => {
                let value = row.value;
                if (row.data_type === 'number') value = parseFloat(value);
                else if (row.data_type === 'boolean') value = value === 'true';
                settings[row.key_name] = value;
            });

            // 필수 설정 확인
            const requiredSettings = ['min_trade_amount_krw', 'max_trade_amount_krw', 'premium_threshold_percent', 'trading_intensity_threshold'];
            const missingSettings = requiredSettings.filter(key => settings[key] === undefined);
            
            if (missingSettings.length > 0) {
                connection.release();
                return { valid: false, error: `봇 설정이 완료되지 않았습니다: ${missingSettings.join(', ')}` };
            }

            // 예산 범위 확인
            if (budgetKrw < settings.min_trade_amount_krw || budgetKrw > settings.max_trade_amount_krw) {
                connection.release();
                return { 
                    valid: false, 
                    error: `거래 금액은 ${settings.min_trade_amount_krw.toLocaleString()}원 ~ ${settings.max_trade_amount_krw.toLocaleString()}원 범위여야 합니다` 
                };
            }

            // 코인 정보 확인
            const [coinRows] = await connection.execute(`
                SELECT * FROM coins 
                WHERE symbol = ? AND is_active = TRUE AND is_tradable = TRUE
            `, [symbol.toUpperCase()]);

            if (coinRows.length === 0) {
                connection.release();
                return { valid: false, error: `거래 불가능한 코인입니다: ${symbol}` };
            }

            // 거래소 정보 확인
            const [exchangeRows] = await connection.execute(`
                SELECT * FROM exchanges 
                WHERE name IN ('업비트', '바이낸스') AND is_active = TRUE
                ORDER BY name
            `);

            if (exchangeRows.length < 2) {
                connection.release();
                return { valid: false, error: '업비트와 바이낸스가 모두 활성화되어야 합니다' };
            }

            connection.release();

            // API 키 확인
            const apiKeyService = new ApiKeyService(userId);
            const verifiedExchanges = await apiKeyService.getVerifiedExchanges();
            
            if (verifiedExchanges.length < 2) {
                return { 
                    valid: false, 
                    error: '최소 2개 거래소의 인증된 API 키가 필요합니다' 
                };
            }

            // 입금주소 확인
            const settingsService = new UserSettingsService(userId);
            const upbitAddr = await settingsService.getDepositAddress(exchangeRows.find(e => e.name === '업비트').id, symbol);
            const binanceAddr = await settingsService.getDepositAddress(exchangeRows.find(e => e.name === '바이낸스').id, symbol);
            
            if (!upbitAddr?.address || !binanceAddr?.address) {
                return { 
                    valid: false, 
                    error: `업비트와 바이낸스 ${symbol} 입금주소가 모두 필요합니다` 
                };
            }

            return {
                valid: true,
                data: {
                    coin: coinRows[0],
                    settings: settings,
                    exchanges: exchangeRows,
                    verifiedExchanges: verifiedExchanges,
                    addresses: { upbit: upbitAddr, binance: binanceAddr }
                }
            };

        } catch (error) {
            this.logger.error('거래 조건 검증 실패', { userId, symbol, budgetKrw, error: error.message });
            return { valid: false, error: `검증 실패: ${error.message}` };
        }
    }

    /**
     * 거래 내역 생성
     */
    async createTradeRecord(userId, coinId, dryRun) {
        try {
            const connection = await db.getConnection();
            const [result] = await connection.execute(`
                INSERT INTO trade_history (
                    user_id, coin_id, status, created_at,
                    gross_profit, net_profit, profit_rate, trading_fees, transfer_fees,
                    error_message
                ) VALUES (?, ?, 'pending', NOW(), 0, 0, 0, 0, 0, ?)
            `, [userId, coinId, dryRun ? 'DRY_RUN_MODE' : null]);
            
            connection.release();
            
            const tradeId = result.insertId;
            this.logger.info('거래 내역 생성', { tradeId, userId, coinId, dryRun });
            
            return tradeId;
        } catch (error) {
            this.logger.error('거래 내역 생성 실패', { userId, coinId, error: error.message });
            throw error;
        }
    }

    /**
     * 시장 분석
     */
    async analyzeMarket(symbol, coin) {
        try {
            // 환율 정보
            const exchangeRate = await this.exchangeRateService.getUsdKrwRate();
            
            // 업비트 데이터
            const upbitMarket = coin.upbit_market || `KRW-${symbol.toUpperCase()}`;
            const [upbitTicker, upbitOrderbook] = await Promise.all([
                this.upbitService.getTicker(upbitMarket),
                this.upbitService.getOrderbook(upbitMarket, 5)
            ]);

            // 바이낸스 데이터
            const binanceSymbol = coin.binance_symbol || `${symbol.toUpperCase()}USDT`;
            const [binanceTicker, binanceOrderbook] = await Promise.all([
                this.binanceService.getTicker(binanceSymbol),
                this.binanceService.getOrderbook(binanceSymbol, 5)
            ]);

            // 평균가 계산
            const upbitAskAvg = this.upbitService.calculateAveragePrice(upbitOrderbook, 'ask');
            const upbitBidAvg = this.upbitService.calculateAveragePrice(upbitOrderbook, 'bid');
            const binanceAskAvg = this.binanceService.calculateAveragePrice(binanceOrderbook, 'ask');
            const binanceBidAvg = this.binanceService.calculateAveragePrice(binanceOrderbook, 'bid');

            // 김프 계산
            const upbitSellPrice = upbitBidAvg.averagePrice;  // 업비트에서 매도할 가격
            const binanceBuyPriceKrw = binanceAskAvg.averagePrice * exchangeRate.rate;  // 바이낸스에서 매수할 가격(원화)
            const premium = ((upbitSellPrice - binanceBuyPriceKrw) / binanceBuyPriceKrw) * 100;

            return {
                symbol: symbol,
                exchangeRate: exchangeRate,
                upbit: {
                    ticker: upbitTicker,
                    askPrice: upbitAskAvg.averagePrice,
                    bidPrice: upbitBidAvg.averagePrice,
                    askQuantity: upbitAskAvg.totalQuantity,
                    bidQuantity: upbitBidAvg.totalQuantity
                },
                binance: {
                    ticker: binanceTicker,
                    askPrice: binanceAskAvg.averagePrice,
                    bidPrice: binanceBidAvg.averagePrice,
                    askPriceKrw: binanceAskAvg.averagePrice * exchangeRate.rate,
                    bidPriceKrw: binanceBidAvg.averagePrice * exchangeRate.rate,
                    askQuantity: binanceAskAvg.totalQuantity,
                    bidQuantity: binanceBidAvg.totalQuantity
                },
                premium: premium,
                timestamp: new Date()
            };

        } catch (error) {
            this.logger.error('시장 분석 실패', { symbol, error: error.message });
            throw error;
        }
    }

    /**
     * 거래 파라미터 계산
     */
    async calculateTradeParameters(budgetKrw, marketAnalysis, settings) {
        try {
            // 거래 방향 결정 (프리미엄 기반)
            const isPositivePremium = marketAnalysis.premium > 0;
            
            let buyExchange, sellExchange, buyPrice, sellPrice;
            
            if (isPositivePremium) {
                // 바이낸스 매수 → 업비트 매도
                buyExchange = '바이낸스';
                sellExchange = '업비트';
                buyPrice = marketAnalysis.binance.askPriceKrw;
                sellPrice = marketAnalysis.upbit.bidPrice;
            } else {
                // 업비트 매수 → 바이낸스 매도
                buyExchange = '업비트';
                sellExchange = '바이낸스';
                buyPrice = marketAnalysis.upbit.askPrice;
                sellPrice = marketAnalysis.binance.bidPriceKrw;
            }

            // 수량 계산 (수수료 고려)
            const tradingFeeRate = 0.0025; // 0.25%
            const slippageRate = 0.001;    // 0.1%
            
            const adjustedBuyPrice = buyPrice * (1 + slippageRate);
            const adjustedSellPrice = sellPrice * (1 - slippageRate);
            
            // 수수료를 고려한 실제 수량
            const grossQuantity = budgetKrw / adjustedBuyPrice;
            const buyFee = budgetKrw * tradingFeeRate;
            const actualBudget = budgetKrw - buyFee;
            const quantity = actualBudget / adjustedBuyPrice;

            return {
                direction: isPositivePremium ? 'BINANCE_TO_UPBIT' : 'UPBIT_TO_BINANCE',
                buyExchange: buyExchange,
                sellExchange: sellExchange,
                buyPrice: adjustedBuyPrice,
                sellPrice: adjustedSellPrice,
                quantity: quantity,
                premium: marketAnalysis.premium,
                tradingFeeRate: tradingFeeRate,
                slippageRate: slippageRate
            };

        } catch (error) {
            this.logger.error('거래 파라미터 계산 실패', { budgetKrw, error: error.message });
            throw error;
        }
    }

    /**
     * 거래 사이클 실행
     */
    async executeTradeCycle(tradeId, userId, symbol, tradeParams, validationData, dryRun) {
        try {
            // 거래소 ID 매핑
            const buyExchangeId = validationData.exchanges.find(e => e.name === tradeParams.buyExchange).id;
            const sellExchangeId = validationData.exchanges.find(e => e.name === tradeParams.sellExchange).id;

            // 거래 내역 업데이트
            await this.updateTradeRecord(tradeId, {
                buy_exchange_id: buyExchangeId,
                sell_exchange_id: sellExchangeId,
                buy_price: tradeParams.buyPrice,
                sell_price: tradeParams.sellPrice,
                quantity: tradeParams.quantity
            });

            this.logger.info(`거래 사이클 시작`, {
                tradeId, symbol,
                direction: `${tradeParams.buyExchange} → ${tradeParams.sellExchange}`,
                premium: `${tradeParams.premium.toFixed(4)}%`,
                quantity: tradeParams.quantity.toFixed(6)
            });

            // 1. 매수 단계
            await this.updateTradeRecord(tradeId, { status: 'buying' });
            await this.executeBuyOrder(tradeId, tradeParams, dryRun);

            // 2. 전송 단계
            await this.updateTradeRecord(tradeId, { status: 'transferring' });
            await this.executeTransfer(tradeId, userId, symbol, tradeParams, validationData, dryRun);

            // 3. 매도 단계
            await this.updateTradeRecord(tradeId, { status: 'selling' });
            await this.executeSellOrder(tradeId, tradeParams, dryRun);

            // 4. 수익 계산
            const profitCalculation = this.calculateProfit(tradeParams, validationData.coin);

            return {
                success: true,
                grossProfit: profitCalculation.grossProfit,
                netProfit: profitCalculation.netProfit,
                profitRate: profitCalculation.profitRate,
                tradingFees: profitCalculation.tradingFees,
                transferFees: profitCalculation.transferFees
            };

        } catch (error) {
            this.logger.error(`거래 사이클 실행 실패`, { tradeId, error: error.message });
            return {
                success: false,
                error: error.message,
                grossProfit: 0,
                netProfit: 0,
                profitRate: 0,
                tradingFees: 0,
                transferFees: 0
            };
        }
    }

    /**
     * 매수 실행
     */
    async executeBuyOrder(tradeId, tradeParams, dryRun) {
        this.logger.info(`매수 단계 시작`, {
            tradeId,
            exchange: tradeParams.buyExchange,
            quantity: tradeParams.quantity.toFixed(6),
            price: tradeParams.buyPrice.toFixed(2)
        });

        if (dryRun) {
            await this.simulateDelay(500, 2000);
            this.logger.info(`매수 시뮬레이션 완료`, { tradeId });
        } else {
            // TODO: 실제 거래소 API 호출
            throw new Error('실제 매수 주문 기능은 아직 구현되지 않았습니다');
        }
    }

    /**
     * 전송 실행
     */
    async executeTransfer(tradeId, userId, symbol, tradeParams, validationData, dryRun) {
        this.logger.info(`전송 단계 시작`, {
            tradeId,
            from: tradeParams.buyExchange,
            to: tradeParams.sellExchange,
            quantity: tradeParams.quantity.toFixed(6)
        });

        // 입금주소 확인
        const targetExchange = tradeParams.sellExchange === '업비트' ? 'upbit' : 'binance';
        const depositInfo = validationData.addresses[targetExchange];
        
        this.logger.info(`입금주소 확인`, {
            tradeId,
            address: depositInfo.address,
            memo: depositInfo.memo || '없음'
        });

        if (dryRun) {
            await this.simulateDelay(30000, 60000);
            this.logger.info(`전송 시뮬레이션 완료`, { tradeId });
        } else {
            // TODO: 실제 출금 API 호출
            throw new Error('실제 코인 전송 기능은 아직 구현되지 않았습니다');
        }
    }

    /**
     * 매도 실행
     */
    async executeSellOrder(tradeId, tradeParams, dryRun) {
        this.logger.info(`매도 단계 시작`, {
            tradeId,
            exchange: tradeParams.sellExchange,
            quantity: tradeParams.quantity.toFixed(6),
            price: tradeParams.sellPrice.toFixed(2)
        });

        if (dryRun) {
            await this.simulateDelay(500, 2000);
            this.logger.info(`매도 시뮬레이션 완료`, { tradeId });
        } else {
            // TODO: 실제 거래소 API 호출
            throw new Error('실제 매도 주문 기능은 아직 구현되지 않았습니다');
        }
    }

    /**
     * 수익 계산
     */
    calculateProfit(tradeParams, coin) {
        const { buyPrice, sellPrice, quantity, tradingFeeRate } = tradeParams;
        
        // 총 수익
        const grossProfit = (sellPrice - buyPrice) * quantity;
        
        // 거래 수수료
        const buyFee = buyPrice * quantity * tradingFeeRate;
        const sellFee = sellPrice * quantity * tradingFeeRate;
        const tradingFees = buyFee + sellFee;
        
        // 전송 수수료 (코인별 고정 수수료)
        const transferFees = (coin.withdrawal_fee || 0) * sellPrice;
        
        // 순수익
        const netProfit = grossProfit - tradingFees - transferFees;
        const profitRate = (netProfit / (buyPrice * quantity)) * 100;

        return {
            grossProfit,
            netProfit,
            profitRate,
            tradingFees,
            transferFees
        };
    }

    /**
     * 거래 내역 업데이트
     */
    async updateTradeRecord(tradeId, updates) {
        try {
            const connection = await db.getConnection();
            
            const fields = [];
            const values = [];
            
            Object.keys(updates).forEach(key => {
                fields.push(`${key} = ?`);
                values.push(updates[key]);
            });
            
            if (fields.length === 0) {
                connection.release();
                return;
            }
            
            values.push(tradeId);
            
            await connection.execute(`
                UPDATE trade_history 
                SET ${fields.join(', ')} 
                WHERE id = ?
            `, values);
            
            connection.release();
            
        } catch (error) {
            this.logger.error('거래 내역 업데이트 실패', { tradeId, updates, error: error.message });
            throw error;
        }
    }

    /**
     * 최종 거래 내역 완료
     */
    async finalizeTradeRecord(tradeId, executionResult) {
        await this.updateTradeRecord(tradeId, {
            status: executionResult.success ? 'completed' : 'failed',
            gross_profit: executionResult.grossProfit,
            net_profit: executionResult.netProfit,
            profit_rate: executionResult.profitRate,
            trading_fees: executionResult.tradingFees,
            transfer_fees: executionResult.transferFees,
            completed_at: new Date(),
            error_message: executionResult.error || null
        });
    }

    /**
     * 거래 실패 처리
     */
    async markTradeFailed(tradeId, errorMessage) {
        await this.updateTradeRecord(tradeId, {
            status: 'failed',
            error_message: errorMessage,
            completed_at: new Date()
        });
    }

    /**
     * 시뮬레이션 지연
     */
    async simulateDelay(minMs, maxMs) {
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}

module.exports = TradeExecutionService;
