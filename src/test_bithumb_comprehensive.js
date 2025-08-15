const BithumbService = require('./services/BithumbService');
const CryptoUtil = require('./utils/CryptoUtil');
const db = require('./config/database');

async function testBithumbComprehensive() {
    try {
        console.log('=== 빗썸 종합 인증 테스트 ===');
        
        // DB에서 암호화된 키 조회
        const connection = await db.getConnection();
        const [rows] = await connection.execute(
            'SELECT api_key, secret_key FROM user_exchange_credentials WHERE user_id = 6 AND exchange_id = 3'
        );
        connection.release();
        
        if (rows.length === 0) {
            console.log('❌ 빗썸 API 키를 찾을 수 없습니다.');
            return;
        }
        
        // 키 복호화
        const apiKey = CryptoUtil.decrypt(rows[0].api_key);
        const secretKey = CryptoUtil.decrypt(rows[0].secret_key);
        
        console.log('API Key 길이:', apiKey.length);
        console.log('Secret Key 길이:', secretKey.length);
        
        // 1. HMAC 방식 테스트
        console.log('\n=== HMAC 방식 테스트 ===');
        process.env.BITHUMB_AUTH_METHOD = 'HMAC';
        const hmacService = new BithumbService();
        
        try {
            const hmacResult = await hmacService.getBalance(apiKey, secretKey);
            console.log('✅ HMAC 방식 성공:', hmacResult.fiatBalance.toLocaleString(), 'KRW');
        } catch (hmacError) {
            console.log('❌ HMAC 방식 실패:', hmacError.message);
        }
        
        // 2. JWT 방식 테스트
        console.log('\n=== JWT 방식 테스트 ===');
        process.env.BITHUMB_AUTH_METHOD = 'JWT';
        const jwtService = new BithumbService();
        
        try {
            const jwtResult = await jwtService.getBalance(apiKey, secretKey);
            console.log('✅ JWT 방식 성공:', jwtResult.fiatBalance.toLocaleString(), 'KRW');
        } catch (jwtError) {
            console.log('❌ JWT 방식 실패:', jwtError.message);
        }
        
        // 3. 공개 API 테스트 (인증 방식 무관)
        console.log('\n=== 공개 API 테스트 ===');
        try {
            const ticker = await hmacService.getTicker('KRW-BTC');
            console.log('✅ 공개 API 성공:', ticker.price.toLocaleString(), '원');
        } catch (publicError) {
            console.log('❌ 공개 API 실패:', publicError.message);
        }
        
    } catch (error) {
        console.error('❌ 종합 테스트 실패:', error.message);
    }
}

testBithumbComprehensive();
