const crypto = require('crypto');

class CryptoUtil {
    constructor() {
        this.algorithm = 'aes-256-gcm';
        this.keyLength = 32;
        this.ivLength = 16;
        this.tagLength = 16;
        
        const masterKey = process.env.ENCRYPTION_KEY;
        if (!masterKey || masterKey.length < 32) {
            throw new Error('⚠️  환경변수 ENCRYPTION_KEY 설정되지 않았거나 32자 미만입니다');
        }
        this.masterKey = Buffer.from(masterKey.slice(0, 32), 'utf8');
    }

    // 평문을 암호화하여 Buffer 반환
    encrypt(plaintext) {
        if (!plaintext || plaintext.trim() === '') return Buffer.alloc(0);
        
        try {
            const iv = crypto.randomBytes(this.ivLength);
            const cipher = crypto.createCipheriv(this.algorithm, this.masterKey, iv);
            
            let encrypted = cipher.update(plaintext, 'utf8');
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            const tag = cipher.getAuthTag();
            
            // IV + 암호화된 데이터 + 인증 태그 순서로 결합
            return Buffer.concat([iv, encrypted, tag]);
        } catch (error) {
            console.error('암호화 실패:', error.message);
            throw new Error('데이터 암호화에 실패했습니다');
        }
    }

    // 암호화된 Buffer를 복호화하여 평문 반환
    decrypt(encryptedBuffer) {
        if (!encryptedBuffer || encryptedBuffer.length === 0) return '';
        
        try {
            const iv = encryptedBuffer.slice(0, this.ivLength);
            const encrypted = encryptedBuffer.slice(this.ivLength, -this.tagLength);
            const tag = encryptedBuffer.slice(-this.tagLength);
            
            const decipher = crypto.createDecipheriv(this.algorithm, this.masterKey, iv);
            decipher.setAuthTag(tag);
            
            let decrypted = decipher.update(encrypted);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            
            return decrypted.toString('utf8');
        } catch (error) {
            console.error('복호화 실패:', error.message);
            return '';
        }
    }

    // API 키 마스킹 (보안상 일부만 표시)
    maskKey(key) {
        if (!key || key.length < 8) return '****';
        return key.substring(0, 4) + '*'.repeat(Math.max(4, key.length - 8)) + key.substring(key.length - 4);
    }

    // 키 검증 (형식 체크)
    validateApiKey(key, type = 'general') {
        if (!key || typeof key !== 'string') {
            return { valid: false, message: 'API 키가 비어있습니다' };
        }

        if (type === 'upbit') {
            if (key.length < 32) {
                return { valid: false, message: '업비트 API 키 길이가 너무 짧습니다' };
            }
        } else if (type === 'binance') {
            if (key.length !== 64) {
                return { valid: false, message: '바이낸스 API 키는 64자여야 합니다' };
            }
        }

        return { valid: true, message: 'API 키 형식이 올바릅니다' };
    }
}

module.exports = new CryptoUtil();
