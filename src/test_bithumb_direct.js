const crypto = require('crypto');
const axios = require('axios');

// 🚨 실제 빗썸 API 키로 교체하세요 (암호화되지 않은 원본)
const API_KEY = '52c061c182b68af4fc98bc592967f680a7f776375c7d9566';  // 로그에서 확인한 키
const SECRET_KEY = 'YzFkZGNhZDJmMWViNDBiMDYwYzU4NGI2OGZmYmYzZWVjYzVmMmI2N2YxODZhMWY1NzAzMTVhN2E5MjY5MTM5';  // 실제 시크릿 키로 교체

async function testBithumbDirect() {
    try {
        console.log('=== 빗썸 직접 인증 테스트 ===');
        
        const endpoint = '/info/balance';
        const params = { currency: 'ALL' };
        const nonce = Date.now();
        
        const postData = new URLSearchParams(params).toString();
        const signaturePayload = endpoint + String.fromCharCode(0) + postData + String.fromCharCode(0) + nonce.toString();
        
        const signature = crypto
            .createHmac('sha512', SECRET_KEY)
            .update(signaturePayload)
            .digest('base64');

        console.log('API Key 길이:', API_KEY.length);
        console.log('Secret Key 길이:', SECRET_KEY.length);
        console.log('Nonce:', nonce);
        console.log('Signature Payload:', signaturePayload.replace(/\0/g, '[NULL]'));
        console.log('Generated Signature:', signature);

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Api-Key': API_KEY,
            'Api-Sign': signature,
            'Api-Nonce': nonce.toString(),
            'User-Agent': 'CoinBot-Direct-Test/1.0'
        };

        console.log('\n=== 요청 전송 ===');
        const response = await axios.post('https://api.bithumb.com' + endpoint, postData, {
            headers,
            timeout: 15000,
            validateStatus: () => true  // 모든 상태 코드 허용
        });

        console.log('HTTP Status:', response.status);
        console.log('Response:', response.data);
        
        if (response.data.status === '0000') {
            console.log('✅ 성공: API 키가 정상 작동합니다!');
        } else {
            console.log('❌ 실패:', response.data.status, '-', response.data.message);
        }

    } catch (error) {
        console.error('❌ 네트워크 오류:', error.message);
        if (error.response) {
            console.error('Response Status:', error.response.status);
            console.error('Response Data:', error.response.data);
        }
    }
}

testBithumbDirect();
