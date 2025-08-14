// services/CoinAPIService.js (향후 구현용)
class CoinAPIService {
    // 공개 API로 기본 정보 조회
    async getBinanceSymbolInfo(symbol) {
        try {
            const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
            const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
            
            if (symbolInfo) {
                return {
                    symbol: symbolInfo.symbol,
                    baseAsset: symbolInfo.baseAsset,
                    quoteAsset: symbolInfo.quoteAsset,
                    status: symbolInfo.status,
                    tradingStatus: symbolInfo.status === 'TRADING'
                };
            }
            return null;
        } catch (error) {
            console.error(`바이낸스 ${symbol} 정보 조회 실패:`, error);
            return null;
        }
    }

    // 업비트 지원 마켓 조회
    async getUpbitMarkets() {
        try {
            const response = await axios.get('https://api.upbit.com/v1/market/all');
            return response.data.map(market => ({
                market: market.market,
                korean_name: market.korean_name,
                english_name: market.english_name
            }));
        } catch (error) {
            console.error('업비트 마켓 조회 실패:', error);
            return [];
        }
    }
}
