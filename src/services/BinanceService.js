const ExchangeService = require('./ExchangeService');

class BinanceService extends ExchangeService {
    constructor() {
        super('Binance', 'https://api.binance.com/api/v3', 'wss://stream.binance.com:9443/ws');
    }

    // 바이낸스 티커 정보 조회
    async getTicker(symbol) {
        try {
            const data = await this.makeRequest('/ticker/price', { symbol: symbol.toUpperCase() });
            
            return {
                exchange: 'binance',
                symbol: data.symbol,
                price: parseFloat(data.price),
                timestamp: new Date()
            };
        } catch (error) {
            this.logger.error(`바이낸스 티커 조회 실패: ${symbol}`, { error: error.message });
            throw error;
        }
    }

    // 바이낸스 호가창 정보 조회
    async getOrderbook(symbol, limit = 5) {
        try {
            const data = await this.makeRequest('/depth', { 
                symbol: symbol.toUpperCase(), 
                limit: limit 
            });
            
            return {
                exchange: 'binance',
                symbol: symbol.toUpperCase(),
                timestamp: new Date(),
                asks: data.asks.slice(0, limit).map(ask => ({
                    price: parseFloat(ask[0]),
                    quantity: parseFloat(ask[1])
                })),
                bids: data.bids.slice(0, limit).map(bid => ({
                    price: parseFloat(bid[0]),
                    quantity: parseFloat(bid[1])
                }))
            };
        } catch (error) {
            this.logger.error(`바이낸스 호가창 조회 실패: ${symbol}`, { error: error.message });
            throw error;
        }
    }

    // 바이낸스 24시간 통계 조회
    async get24hrStats(symbol) {
        try {
            const data = await this.makeRequest('/ticker/24hr', { symbol: symbol.toUpperCase() });
            
            return {
                exchange: 'binance',
                symbol: data.symbol,
                price: parseFloat(data.lastPrice),
                volume: parseFloat(data.volume),
                change: parseFloat(data.priceChange),
                changePercent: parseFloat(data.priceChangePercent),
                high: parseFloat(data.highPrice),
                low: parseFloat(data.lowPrice),
                timestamp: new Date()
            };
        } catch (error) {
            this.logger.error(`바이낸스 24시간 통계 조회 실패: ${symbol}`, { error: error.message });
            throw error;
        }
    }

    // WebSocket 실시간 데이터 구독
    subscribeRealtime(symbol, onTicker, onOrderbook) {
        if (!this.wsUrl) {
            throw new Error('WebSocket URL이 설정되지 않았습니다.');
        }

        const streamName = `${symbol.toLowerCase()}@ticker/${symbol.toLowerCase()}@depth5@100ms`;
        const wsUrl = `${this.wsUrl}/${streamName}`;

        const ws = this.createWebSocket(wsUrl, (data) => {
            try {
                if (data.e === '24hrTicker' && onTicker) {
                    onTicker({
                        exchange: 'binance',
                        symbol: data.s,
                        price: parseFloat(data.c),
                        volume: parseFloat(data.v),
                        change: parseFloat(data.P),
                        timestamp: new Date(data.E)
                    });
                } else if (data.e === 'depthUpdate' && onOrderbook) {
                    onOrderbook({
                        exchange: 'binance',
                        symbol: data.s,
                        timestamp: new Date(),
                        asks: data.a.map(ask => ({
                            price: parseFloat(ask[0]),
                            quantity: parseFloat(ask[1])
                        })),
                        bids: data.b.map(bid => ({
                            price: parseFloat(bid[0]),
                            quantity: parseFloat(bid[1])
                        }))
                    });
                }
            } catch (error) {
                this.logger.error('바이낸스 WebSocket 데이터 처리 실패', { error: error.message });
            }
        });

        return ws;
    }
}

module.exports = BinanceService;