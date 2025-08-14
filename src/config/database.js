// src/config/database.js
const mysql = require('mysql2');

// 데이터베이스 연결 설정
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true,
    typeCast: function (field, next) {
        // DECIMAL과 NEWDECIMAL 타입을 숫자로 변환
        if (field.type === 'NEWDECIMAL' || field.type === 'DECIMAL') {
            const val = field.string();
            return val === null ? null : Number(val);
        }
        
        // DATETIME/TIMESTAMP는 문자열로 유지 (타임존 이슈 방지)
        if (field.type === 'DATETIME' || field.type === 'TIMESTAMP') {
            return field.string();
        }
        
        // 다른 타입은 기본 처리
        return next();
    }
};

// 콜백 기반 풀 (express-mysql-session용)
const pool = mysql.createPool(dbConfig);

// 프로미스 기반 풀 (일반 쿼리용)
const promisePool = pool.promise();

// 연결 테스트
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ MySQL 연결 실패:', err.message);
        process.exit(1);
    } else {
        console.log('✅ MySQL 연결 풀 생성 성공');
        connection.release();
    }
});

// 기본 export는 프로미스 풀 (routes에서 사용)
module.exports = promisePool;

// express-mysql-session용 콜백 풀
module.exports.pool = pool;

// 설정 정보
module.exports.config = dbConfig;
