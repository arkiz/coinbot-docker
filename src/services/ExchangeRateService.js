const axios = require('axios');
const winston = require('winston');

class ExchangeRateService {
    constructor() {
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level.toUpperCase()}] [ExchangeRate] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ filename: '../logs/exchange.log' })
            ]
        });
    }

    // USD/KRW 환율 조회 (업비트 운영사 Dunamu API 사용)
    async getUsdKrwRate() {
        try {
            const response = await axios.get(
                'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD',
                { timeout: 10000 }
            );
            
            if (!response.data || response.data.length === 0) {
                throw new Error('환율 데이터를 가져올 수 없습니다.');
            }

            const rate = parseFloat(response.data[0].basePrice);
            this.logger.info('USD/KRW 환율 조회 성공', { rate });
            
            return {
                rate,
                timestamp: new Date(),
                source: 'dunamu'
            };
        } catch (error) {
            this.logger.error('USD/KRW 환율 조회 실패', { error: error.message });
            
            // 백업 환율 (고정값 사용 - 실제 운영에서는 다른 API 사용 권장)
            const fallbackRate = 1300; // 대략적인 환율
            this.logger.warn('백업 환율 사용', { fallbackRate });
            
            return {
                rate: fallbackRate,
                timestamp: new Date(),
                source: 'fallback'
            };
        }
    }
}

module.exports = ExchangeRateService;