const ExchangeService = require('./ExchangeService');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');

class BithumbService extends ExchangeService {
    constructor() {
        super('Bithumb', 'https://api.bithumb.com', null);
    }

    // 빗썸 API 2.0 JWT 인증 방식 (올바른 엔드포인트 필요)
    async makeV2Request(endpoint, params = {}, apiKey, secretKey, method = 'GET') {
        try {
            const nonce = Date.now().toString();
            
            // JWT 페이로드 구성
            const payload = {
                access_key: String(apiKey).trim(),
                nonce: nonce
            };

            // Base64 Secret Key를 JWT 서명에 직접 사용
            const token = jwt.sign(payload, String(secretKey).trim(), { 
                algorithm: 'HS256',
                noTimestamp: true  // 빗썸 호환성
            });

            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'CoinBot/1.0'
            };

            this.logger.info(`빗썸 V2 API 요청: ${endpoint}`, {
                method,
                nonce,
                tokenLength: token.length
            });

            const url = `${this.baseUrl}${endpoint}`;
            const config = {
                headers,
                timeout: 15000,
                validateStatus: (status) => status < 500
            };

            const response = method === 'GET' 
                ? await axios.get(url, config)
                : await axios.post(url, params, config);

            this.logger.info(`빗썸 V2 API 응답: ${response.status}`, {
                contentType: response.headers['content-type'],
                hasData: !!response.data
            });

            // 성공 응답 확인
            if (response.status === 200) {
                return { status: '0000', data: response.data };
            } else {
                const errorCode = response.data?.status || response.status;
                const errorMsg = response.data?.message || response.statusText;
                throw new Error(`빗썸 V2 API 오류 (${errorCode}): ${errorMsg}`);
            }

        } catch (error) {
            this.logger.error(`빗썸 V2 API 요청 실패: ${endpoint}`, {
                error: error.message,
                status: error.response?.status
            });
            throw error;
        }
    }

    async getBalance(apiKey, secretKey) {
        try {
            const cleanApiKey = String(apiKey || '').trim();
            const cleanSecretKey = String(secretKey || '').trim();

            if (!cleanApiKey || !cleanSecretKey) {
                throw new Error('빗썸 API Key/Secret이 비어있습니다');
            }

            this.logger.info('빗썸 잔고 조회 시작', {
                apiKeyLength: cleanApiKey.length,
                secretKeyLength: cleanSecretKey.length
            });

            // TODO: 빗썸 문서에서 확인한 정확한 엔드포인트로 교체 필요
            // 예상 경로들 (문서 확인 후 정확한 경로로 수정)
            const possibleEndpoints = [
                '/info/balance',           // V1 방식 (HMAC)
                '/api/v2/account',         // V2 가능 경로 1
                '/openapi/v2/balance',     // V2 가능 경로 2
                '/v2/account/balance'      // V2 가능 경로 3
            ];

            let lastError = null;

            for (const endpoint of possibleEndpoints) {
                try {
                    this.logger.info(`빗썸 엔드포인트 시도: ${endpoint}`);
                    
                    const response = await this.makeV2Request(endpoint, {}, cleanApiKey, cleanSecretKey);
                    
                    // 성공한 경우 잔고 파싱
                    return this.parseBalanceResponse(response);

                } catch (error) {
                    lastError = error;
                    this.logger.warn(`빗썸 엔드포인트 실패: ${endpoint}`, { error: error.message });
                    
                    // 404는 계속 시도, 인증 오류는 즉시 중단
                    if (!error.message.includes('404')) {
                        throw error;
                    }
                }
            }

            // 모든 엔드포인트에서 404 발생
            throw new Error('빗썸 API 모든 엔드포인트에서 404 오류 - 문서에서 정확한 경로 확인이 필요합니다');

        } catch (error) {
            this.logger.error('빗썸 잔고 조회 실패', { error: error.message });
            
            if (error.message.includes('404')) {
                throw new Error('빗썸 API 엔드포인트를 찾을 수 없습니다 - API 문서에서 정확한 경로를 확인해주세요');
            }
            
            throw error;
        }
    }

    // 잔고 응답 파싱 (유연한 구조 지원)
    parseBalanceResponse(response) {
        try {
            const data = response.data || response;
            
            // 기본 구조로 파싱 시도
            return {
                exchange: 'bithumb',
                fiatCurrency: 'KRW',
                fiatBalance: 0,
                fiatLocked: 0,
                coinBalances: [],
                totalAssets: 0,
                timestamp: new Date(),
                rawData: data  // 디버깅용 원본 데이터 포함
            };

        } catch (error) {
            this.logger.error('빗썸 잔고 응답 파싱 실패', { error: error.message });
            throw error;
        }
    }

    // 기존 공개 API는 정상 작동하므로 유지
    async getTicker(symbol) {
        try {
            const bithumbSymbol = symbol.replace('KRW-', '').toUpperCase();
            const data = await this.makeRequest(`/public/ticker/${bithumbSymbol}_KRW`);
            
            if (!data || data.status !== '0000') {
                throw new Error(`빗썸 티커 데이터 오류: ${data?.message || '응답 없음'}`);
            }

            const ticker = data.data;
            return {
                exchange: 'bithumb',
                symbol: `${bithumbSymbol}_KRW`,
                price: parseFloat(ticker.closing_price),
                volume: parseFloat(ticker.units_traded_24H),
                change: parseFloat(ticker.fluctate_24H),
                changeRate: parseFloat(ticker.fluctate_rate_24H),
                timestamp: new Date(parseInt(ticker.date))
            };
        } catch (error) {
            this.logger.error(`빗썸 티커 조회 실패: ${symbol}`, { error: error.message });
            throw error;
        }
    }

    async getOrderbook(symbol, limit = 5) {
        try {
            const bithumbSymbol = symbol.replace('KRW-', '').toUpperCase();
            const data = await this.makeRequest(`/public/orderbook/${bithumbSymbol}_KRW`);
            
            if (!data || data.status !== '0000') {
                throw new Error(`빗썸 호가창 데이터 오류: ${data?.message || '응답 없음'}`);
            }

            const orderbook = data.data;
            
            return {
                exchange: 'bithumb',
                symbol: `${bithumbSymbol}_KRW`,
                timestamp: new Date(parseInt(orderbook.timestamp) || Date.now()),
                asks: orderbook.asks.slice(0, limit).map(ask => ({
                    price: parseFloat(ask.price),
                    quantity: parseFloat(ask.quantity)
                })).sort((a, b) => a.price - b.price),
                bids: orderbook.bids.slice(0, limit).map(bid => ({
                    price: parseFloat(bid.price),
                    quantity: parseFloat(bid.quantity)
                })).sort((a, b) => b.price - a.price)
            };
        } catch (error) {
            this.logger.error(`빗썸 호가창 조회 실패: ${symbol}`, { error: error.message });
            throw error;
        }
    }
}

module.exports = BithumbService;
