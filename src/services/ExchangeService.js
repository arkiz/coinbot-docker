const axios = require('axios');
const WebSocket = require('ws');
const winston = require('winston');

// 거래소 API 기본 클래스
class ExchangeService {
    constructor(name, baseUrl, wsUrl = null) {
        this.name = name;
        this.baseUrl = baseUrl;
        this.wsUrl = wsUrl;
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level.toUpperCase()}] [${this.name}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ 
                    filename: '../logs/exchange.log',
                    level: 'info'
                }),
                new winston.transports.File({ 
                    filename: '../logs/error.log', 
                    level: 'error' 
                })
            ]
        });
    }

    // HTTP 요청 공통 메서드
    async makeRequest(endpoint, params = {}) {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            this.logger.info(`API 요청: ${url}`, { params });
            
            const response = await axios.get(url, { 
                params,
                timeout: 10000,
                headers: {
                    'User-Agent': 'CoinBot/1.0'
                }
            });
            
            this.logger.info(`API 응답 성공: ${url}`);
            return response.data;
        } catch (error) {
            this.logger.error(`API 요청 실패: ${endpoint}`, {
                error: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText
            });
            throw error;
        }
    }

    // WebSocket 연결 공통 메서드
    createWebSocket(url, onMessage, onError = null) {
        const ws = new WebSocket(url);
        
        ws.onopen = () => {
            this.logger.info(`WebSocket 연결 성공: ${url}`);
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                onMessage(data);
            } catch (error) {
                this.logger.error('WebSocket 메시지 파싱 실패', { error: error.message });
            }
        };
        
        ws.onerror = (error) => {
            this.logger.error('WebSocket 에러', { error: error.message });
            if (onError) onError(error);
        };
        
        ws.onclose = (event) => {
            this.logger.warn('WebSocket 연결 종료', { 
                code: event.code, 
                reason: event.reason 
            });
        };
        
        return ws;
    }

    // 각 거래소에서 구현해야 할 추상 메서드들
    async getTicker(symbol) {
        throw new Error('getTicker 메서드를 구현해야 합니다.');
    }

    async getOrderbook(symbol, limit = 5) {
        throw new Error('getOrderbook 메서드를 구현해야 합니다.');
    }

    // 호가창 평균가 계산 (기획서 로직 구현)
    calculateAveragePrice(orderbookData, side = 'ask', limit = 5) {
        try {
            const orders = side === 'ask' ? orderbookData.asks : orderbookData.bids;
            const limitedOrders = orders.slice(0, limit);
            
            let totalQuantity = 0;
            let totalAmount = 0;
            
            limitedOrders.forEach(order => {
                const price = parseFloat(order.price);
                const quantity = parseFloat(order.quantity);
                
                totalQuantity += quantity;
                totalAmount += price * quantity;
            });
            
            if (totalQuantity === 0) return null;
            
            const averagePrice = totalAmount / totalQuantity;
            
            this.logger.debug(`${side} 평균가 계산`, {
                side,
                totalQuantity,
                totalAmount,
                averagePrice,
                ordersCount: limitedOrders.length
            });
            
            return {
                averagePrice,
                totalQuantity,
                totalAmount,
                ordersCount: limitedOrders.length
            };
        } catch (error) {
            this.logger.error('평균가 계산 실패', { error: error.message });
            return null;
        }
    }
}

module.exports = ExchangeService;