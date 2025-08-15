const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const ExchangeService = require('./ExchangeService');

class UpbitService extends ExchangeService {
    constructor() {
        super('Upbit', 'https://api.upbit.com/v1', 'wss://api.upbit.com/websocket/v1');
    }

    // 업비트 티커 정보 조회
    async getTicker(market) {
        try {
            const data = await this.makeRequest('/ticker', { markets: market });
            
            if (!data || data.length === 0) {
                throw new Error('업비트 티커 데이터가 없습니다.');
            }

            const ticker = data[0];
            return {
                exchange: 'upbit',
                symbol: ticker.market,
                price: ticker.trade_price,
                volume: ticker.trade_volume,
                change: ticker.change,
                changeRate: ticker.change_rate,
                timestamp: new Date(ticker.timestamp)
            };
        } catch (error) {
            this.logger.error(`업비트 티커 조회 실패: ${market}`, { error: error.message });
            throw error;
        }
    }

    // 업비트 호가창 정보 조회
    async getOrderbook(market, limit = 5) {
        try {
            const data = await this.makeRequest('/orderbook', { markets: market });
            
            if (!data || data.length === 0) {
                throw new Error('업비트 호가창 데이터가 없습니다.');
            }

            const orderbook = data[0];
            const units = orderbook.orderbook_units.slice(0, limit);
            
            return {
                exchange: 'upbit',
                symbol: orderbook.market,
                timestamp: new Date(orderbook.timestamp),
                asks: units.map(unit => ({
                    price: unit.ask_price,
                    quantity: unit.ask_size
                })).sort((a, b) => a.price - b.price), // 낮은 가격순
                bids: units.map(unit => ({
                    price: unit.bid_price,
                    quantity: unit.bid_size
                })).sort((a, b) => b.price - a.price) // 높은 가격순
            };
        } catch (error) {
            this.logger.error(`업비트 호가창 조회 실패: ${market}`, { error: error.message });
            throw error;
        }
    }

    // 업비트 마켓 목록 조회
    async getMarkets() {
        try {
            const data = await this.makeRequest('/market/all', { isDetails: false });
            return data.filter(market => market.market.startsWith('KRW-'));
        } catch (error) {
            this.logger.error('업비트 마켓 목록 조회 실패', { error: error.message });
            throw error;
        }
    }

    // WebSocket 실시간 데이터 구독
    subscribeRealtime(markets, onTicker, onOrderbook) {
        if (!this.wsUrl) {
            throw new Error('WebSocket URL이 설정되지 않았습니다.');
        }

        const ws = this.createWebSocket(this.wsUrl, (data) => {
            try {
                if (data.type === 'ticker' && onTicker) {
                    onTicker({
                        exchange: 'upbit',
                        symbol: data.code,
                        price: data.trade_price,
                        volume: data.trade_volume,
                        timestamp: new Date(data.timestamp)
                    });
                } else if (data.type === 'orderbook' && onOrderbook) {
                    onOrderbook({
                        exchange: 'upbit',
                        symbol: data.code,
                        timestamp: new Date(data.timestamp),
                        asks: data.orderbook_units.map(unit => ({
                            price: unit.ask_price,
                            quantity: unit.ask_size
                        })),
                        bids: data.orderbook_units.map(unit => ({
                            price: unit.bid_price,
                            quantity: unit.bid_size
                        }))
                    });
                }
            } catch (error) {
                this.logger.error('업비트 WebSocket 데이터 처리 실패', { error: error.message });
            }
        });

        ws.onopen = () => {
            // 업비트 WebSocket 구독 메시지 전송
            const subscribeMessage = [
                { ticket: 'coinbot-' + Date.now() },
                { type: 'ticker', codes: markets, isOnlyRealtime: true },
                { type: 'orderbook', codes: markets, isOnlyRealtime: true }
            ];
            
            ws.send(JSON.stringify(subscribeMessage));
            this.logger.info('업비트 실시간 구독 시작', { markets });
        };

        return ws;
    }

    // 업비트 잔고 조회 (인증 필요)
    async getBalance(apiKey, secretKey) {
        try {
            const payload = {
                access_key: apiKey,
                nonce: uuidv4(),
            };

            const token = jwt.sign(payload, secretKey);
            
            const response = await axios.get(`${this.baseUrl}/accounts`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'CoinBot/1.0'
                },
                timeout: 10000
            });

            // 업비트 잔고 데이터 정규화
            const balances = response.data.map(account => ({
                currency: account.currency,
                balance: parseFloat(account.balance),
                locked: parseFloat(account.locked),
                avgBuyPrice: parseFloat(account.avg_buy_price || 0),
                avgBuyPriceModified: account.avg_buy_price_modified,
                unitCurrency: account.unit_currency
            }));

            // KRW 잔고와 코인 잔고 분리
            const krwBalance = balances.find(b => b.currency === 'KRW');
            const coinBalances = balances.filter(b => b.currency !== 'KRW' && b.balance > 0);

            this.logger.info('업비트 잔고 조회 성공', {
                totalAssets: balances.length,
                krwBalance: krwBalance?.balance || 0,
                coinCount: coinBalances.length
            });

            return {
                exchange: 'upbit',
                fiatCurrency: 'KRW',
                fiatBalance: krwBalance?.balance || 0,
                fiatLocked: krwBalance?.locked || 0,
                coinBalances: coinBalances,
                totalAssets: balances.length,
                timestamp: new Date()
            };

        } catch (error) {
            this.logger.error('업비트 잔고 조회 실패', { 
                error: error.message,
                status: error.response?.status 
            });
            
            // API 키 관련 오류 구분
            if (error.response?.status === 401) {
                throw new Error('API 키 인증 실패 - 키를 확인해주세요');
            } else if (error.response?.status === 403) {
                throw new Error('API 권한 부족 - 잔고 조회 권한을 확인해주세요');
            }
            
            throw error;
        }
    }
}

module.exports = UpbitService;