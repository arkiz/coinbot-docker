const axios = require('axios');
const WebSocket = require('ws');
const winston = require('winston');
const db = require('../config/database');

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

    // 정적 메서드: 거래소별 잔고 조회
    static async getBalance(exchangeId, apiKey, secretKey, passphrase = null) {
        try {
            const connection = await db.getConnection();
            const [rows] = await connection.execute('SELECT name FROM exchanges WHERE id = ? AND is_active = TRUE', [exchangeId]);
            connection.release();
            
            if (rows.length === 0) {
                throw new Error('지원하지 않는 거래소이거나 비활성화된 거래소입니다.');
            }
            
            const exchangeName = rows[0].name;
            let service;
            
            // 거래소별 서비스 인스턴스 생성 (빗썸 V2 적용)
            switch (exchangeName) {
                case '업비트':
                    const UpbitService = require('./UpbitService');
                    service = new UpbitService();
                    break;
                    
                case '바이낸스':
                    const BinanceService = require('./BinanceService');
                    service = new BinanceService();
                    break;
                    
                case '빗썸':
                    const BithumbV2Service = require('./BithumbV2Service');
                    service = new BithumbV2Service();
                    break;
                    
                default:
                    throw new Error(`${exchangeName}는 아직 지원하지 않는 거래소입니다.`);
            }
            
        return await service.getBalance(apiKey, secretKey, passphrase);
        
    } catch (error) {
        console.error(`거래소 ${exchangeId} 잔고 조회 실패:`, error);
        throw error;
    }
}

    // 지원되는 거래소 목록 반환 
    static getSupportedExchanges() {
        return ['업비트', '바이낸스', '빗썸'];
    }
    // 각 거래소에서 구현해야 할 추상 메서드들 (인증 API)
    async getBalance(apiKey, secretKey, passphrase = null) {
        throw new Error('getBalance 메서드를 구현해야 합니다.');
    }

    async placeOrder(symbol, side, type, price, quantity, apiKey, secretKey, passphrase = null) {
        throw new Error('placeOrder 메서드를 구현해야 합니다.');
    }
}

module.exports = ExchangeService;