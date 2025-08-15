const ExchangeService = require('./ExchangeService');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');

class BithumbV2Service extends ExchangeService {
    constructor() {
        super('BithumbV2', 'https://api.bithumb.com', null);
    }

    // 빗썸 Open API 2.0 JWT 인증 방식
    async makeV2Request(endpoint, params = {}, apiKey, secretKey, method = 'GET') {
        try {
            const nonce = Date.now().toString();
            
            // JWT 페이로드 구성 (빗썸 v2 방식)
            const payload = {
                access_key: apiKey,
                nonce: nonce,
                ...params
            };

            // Base64 Secret Key를 JWT 서명에 직접 사용
            const token = jwt.sign(payload, secretKey, { algorithm: 'HS256' });

            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'CoinBot/1.0'
            };

            this.logger.info(`빗썸 V2 API 요청: ${endpoint}`, {
                method,
                nonce,
                tokenLength: token.length,
                secretKeyLength: secretKey.length
            });

            const url = `${this.baseUrl}${endpoint}`;
            const response = method === 'GET' 
                ? await axios.get(url, { headers, timeout: 15000, validateStatus: s => s < 500 })
                : await axios.post(url, params, { headers, timeout: 15000, validateStatus: s => s < 500 });

            this.logger.info(`빗썸 V2 API 응답: ${response.status}`, {
                hasData: !!response.data,
                dataKeys: response.data ? Object.keys(response.data) : []
            });

            // v2 응답 형식 확인
            if (response.data && response.data.status === '0000') {
                return response.data;
            } else if (response.data && !response.data.status && response.status === 200) {
                // 일부 v2 API는 status 필드가 없고 HTTP 200으로만 성공 표시
                return { status: '0000', data: response.data };
            } else {
                const errorCode = response.data?.status || response.status;
                const errorMsg = response.data?.message || response.statusText || '알 수 없는 오류';
                throw new Error(`빗썸 V2 API 오류 (${errorCode}): ${errorMsg}`);
            }

        } catch (error) {
            this.logger.error(`빗썸 V2 API 요청 실패: ${endpoint}`, {
                error: error.message,
                status: error.response?.status,
                responseData: error.response?.data
            });
            throw error;
        }
    }

    // 빗썸 v2 잔고 조회 (여러 엔드포인트 시도)
    async getBalance(apiKey, secretKey) {
        try {
            const cleanApiKey = String(apiKey || '').trim();
            const cleanSecretKey = String(secretKey || '').trim();

            if (!cleanApiKey || !cleanSecretKey) {
                throw new Error('빗썸 API Key/Secret이 비어있습니다');
            }

            this.logger.info('빗썸 V2 잔고 조회 시작', {
                apiKeyLength: cleanApiKey.length,
                secretKeyLength: cleanSecretKey.length
            });

            // v2 API 엔드포인트들 순서대로 시도
            const endpoints = [
                '/openapi/v1/user/assets',
                '/v2/user/balance',
                '/openapi/v1/account/balance',
                '/api/v2/user/balance'
            ];

            let lastError = null;

            for (const endpoint of endpoints) {
                try {
                    this.logger.info(`빗썸 V2 엔드포인트 시도: ${endpoint}`);
                    const response = await this.makeV2Request(endpoint, {}, cleanApiKey, cleanSecretKey, 'GET');
                    
                    // 성공한 경우 응답 파싱
                    return this.parseBalanceResponse(response);

                } catch (error) {
                    lastError = error;
                    this.logger.warn(`빗썸 V2 엔드포인트 실패: ${endpoint}`, { error: error.message });
                    
                    // 인증 성공이지만 엔드포인트가 틀린 경우 (404, 405 등)
                    if (error.message.includes('404') || error.message.includes('405')) {
                        continue; // 다음 엔드포인트 시도
                    }
                    
                    // 인증 실패인 경우 (401, 403, 5300 등) 즉시 중단
                    if (error.message.includes('401') || error.message.includes('403') || error.message.includes('5300')) {
                        throw error;
                    }
                }
            }

            // 모든 엔드포인트 실패
            throw lastError || new Error('빗썸 V2 API 모든 엔드포인트에서 실패');

        } catch (error) {
            this.logger.error('빗썸 V2 잔고 조회 실패', { error: error.message });
            
            // 에러 메시지 정규화
            const errorMessage = error.message;
            if (errorMessage.includes('401') || errorMessage.includes('5300')) {
                throw new Error('빗썸 V2 API 키 인증 실패 - API 키를 재발급받아 정확히 입력해주세요');
            } else if (errorMessage.includes('403') || errorMessage.includes('5600')) {
                throw new Error('빗썸 V2 IP 접근 제한 - API 설정에서 현재 서버 IP를 등록해주세요');
            }
            
            throw error;
        }
    }

    // 빗썸 v2 응답 파싱 (유연한 구조 지원)
    parseBalanceResponse(response) {
        try {
            const data = response.data || response;
            
            // 다양한 v2 응답 구조 지원
            let krwInfo = null;
            let assets = [];

            // 패턴 1: data.assets 배열
            if (data.assets && Array.isArray(data.assets)) {
                assets = data.assets;
                krwInfo = assets.find(a => a.currency === 'KRW' || a.asset === 'KRW');
            }
            // 패턴 2: data 직접 객체
            else if (data.KRW || data.krw) {
                const krwData = data.KRW || data.krw;
                krwInfo = {
                    currency: 'KRW',
                    available: krwData.available || krwData.balance || 0,
                    locked: krwData.locked || krwData.in_use || 0,
                    total: krwData.total || 0
                };
                
                // 다른 코인들
                Object.keys(data).forEach(key => {
                    if (key !== 'KRW' && key !== 'krw' && data[key]) {
                        const coinData = data[key];
                        if (coinData.available || coinData.balance || coinData.total) {
                            assets.push({
                                currency: key.toUpperCase(),
                                available: coinData.available || coinData.balance || 0,
                                locked: coinData.locked || coinData.in_use || 0,
                                total: coinData.total || 0
                            });
                        }
                    }
                });
            }

            // KRW 잔고 정보
            const krwAvailable = parseFloat(krwInfo?.available || 0);
            const krwLocked = parseFloat(krwInfo?.locked || 0);

            // 코인 잔고 정보
            const coinBalances = assets
                .filter(asset => asset.currency !== 'KRW' && (parseFloat(asset.total || 0) > 0))
                .map(asset => ({
                    currency: asset.currency.toUpperCase(),
                    balance: parseFloat(asset.available || 0),
                    locked: parseFloat(asset.locked || 0),
                    total: parseFloat(asset.total || asset.available + asset.locked || 0)
                }));

            this.logger.info('빗썸 V2 잔고 파싱 성공', {
                krwBalance: krwAvailable,
                coinCount: coinBalances.length
            });

            return {
                exchange: 'bithumb',
                fiatCurrency: 'KRW',
                fiatBalance: krwAvailable,
                fiatLocked: krwLocked,
                coinBalances: coinBalances,
                totalAssets: coinBalances.length + (krwAvailable > 0 ? 1 : 0),
                timestamp: new Date()
            };

        } catch (error) {
            this.logger.error('빗썸 V2 응답 파싱 실패', { error: error.message });
            throw new Error(`빗썸 V2 응답 파싱 실패: ${error.message}`);
        }
    }

    // v2 공개 API (기존 로직 유지 가능)
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
            this.logger.error(`빗썸 V2 티커 조회 실패: ${symbol}`, { error: error.message });
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
            this.logger.error(`빗썸 V2 호가창 조회 실패: ${symbol}`, { error: error.message });
            throw error;
        }
    }
}

module.exports = BithumbV2Service;
