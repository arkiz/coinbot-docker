USE coinbot_dev;
SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- 김프 차익거래 봇 데이터베이스 초기화 스크립트
-- 생성일: 2025년 6월

-- ==============================================
-- 1. 거래소 정보 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS exchanges (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL,
    type ENUM('domestic', 'overseas') NOT NULL,
    api_url VARCHAR(255) NOT NULL,
    websocket_url VARCHAR(255),
    trading_fee_rate DECIMAL(6, 4) DEFAULT 0.0025,
    withdrawal_fee_rate DECIMAL(6, 4) DEFAULT 0.001,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_exchange_name (name)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==============================================
-- [신규] 사용자 정보 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE,
    role ENUM('admin', 'user') DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- ==============================================
-- [신규] 사용자별 거래소 API Key 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS user_exchange_credentials (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    exchange_id INT NOT NULL,
    api_key VARBINARY(512) NOT NULL,
    secret_key VARBINARY(512) NOT NULL,
    passphrase VARBINARY(512) NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_exchange (user_id, exchange_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 1. user_exchange_credentials 테이블 보안 강화
ALTER TABLE user_exchange_credentials 
MODIFY COLUMN api_key VARBINARY(512) NOT NULL COMMENT '암호화된 API 키',
MODIFY COLUMN secret_key VARBINARY(512) NOT NULL COMMENT '암호화된 시크릿 키',
MODIFY COLUMN passphrase VARBINARY(512) NULL COMMENT '암호화된 패스프레이즈',
ADD COLUMN is_verified TINYINT(1) DEFAULT 0 AFTER is_active,
ADD COLUMN last_tested_at DATETIME NULL AFTER is_verified,
ADD COLUMN last_test_result VARCHAR(100) NULL AFTER last_tested_at;


-- 세션 테이블 (express-mysql-session용)
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
    expires INT(11) UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin,
    PRIMARY KEY (session_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==============================================
-- [신규] 사용자별 환경값 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS user_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    key_name VARCHAR(100) NOT NULL,
    value TEXT NOT NULL,
    data_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==============================================
-- 2. 암호화폐 정보 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS coins (
    id INT PRIMARY KEY AUTO_INCREMENT,
    symbol VARCHAR(20) NOT NULL,
    name VARCHAR(100) NOT NULL,
    network VARCHAR(50),
    withdrawal_fee DECIMAL(20, 8),
    min_withdrawal DECIMAL(20, 8),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_symbol (symbol)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE coins 
ADD COLUMN upbit_market VARCHAR(20) NULL COMMENT '업비트 마켓명 (예: KRW-BTC)',
ADD COLUMN binance_symbol VARCHAR(20) NULL COMMENT '바이낸스 심볼 (예: BTCUSDT)',
ADD COLUMN description TEXT NULL COMMENT '코인 설명',
ADD COLUMN website_url VARCHAR(255) NULL COMMENT '공식 웹사이트',
ADD COLUMN is_tradable BOOLEAN DEFAULT FALSE COMMENT '실거래 가능 여부',
ADD COLUMN created_by INT NULL COMMENT '생성한 관리자 ID',
ADD COLUMN updated_by INT NULL COMMENT '마지막 수정한 관리자 ID',
ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
ADD FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
ADD FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;



-- 3. 코인 변경 이력 추적 테이블
CREATE TABLE IF NOT EXISTS coin_audit_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    coin_id INT NOT NULL,
    user_id INT NULL,
    action_type ENUM('CREATE', 'UPDATE', 'DELETE', 'TOGGLE_STATUS') NOT NULL,
    
    -- 변경 세부사항
    field_name VARCHAR(100) NULL COMMENT '변경된 필드명',
    old_value TEXT NULL COMMENT '변경 전 값',
    new_value TEXT NULL COMMENT '변경 후 값',
    
    -- 변경 메타데이터
    change_reason VARCHAR(255) NULL COMMENT '변경 사유',
    change_source ENUM('ADMIN_WEB', 'API_UPDATE', 'SYSTEM') DEFAULT 'ADMIN_WEB',
    ip_address VARCHAR(45) NULL COMMENT '변경자 IP',
    
    -- 시간 정보
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    
    INDEX idx_coin_audit_coin (coin_id),
    INDEX idx_coin_audit_user (user_id),
    INDEX idx_coin_audit_time (created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4. 성능 최적화 인덱스
CREATE INDEX idx_coins_symbol ON coins(symbol);
CREATE INDEX idx_coins_active ON coins(is_active);
CREATE INDEX idx_coins_tradable ON coins(is_tradable);

-- ==============================================
-- 3. 봇 설정 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS bot_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    key_name VARCHAR(100) NOT NULL UNIQUE,
    value TEXT NOT NULL,
    data_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_exchange (user_id, key_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_bot_settings_user_active (user_id, is_active)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==============================================
-- 4. 매매강도 추적 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS trading_intensity (
    coin_id INT NOT NULL,
    user_id INT NULL,
    current_intensity INT DEFAULT 0,
    last_premium_rate DECIMAL(8, 4),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (coin_id) REFERENCES coins(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    PRIMARY KEY (coin_id, user_id),
    INDEX idx_trading_intensity_user (user_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==============================================
-- 5. 거래 내역 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS trade_history (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NULL,
    coin_id INT NOT NULL,
    buy_exchange_id INT NOT NULL,
    sell_exchange_id INT NOT NULL,
    buy_price DECIMAL(20, 8) NOT NULL,
    sell_price DECIMAL(20, 8) NOT NULL,
    quantity DECIMAL(20, 8) NOT NULL,
    gross_profit DECIMAL(20, 8) NOT NULL,
    net_profit DECIMAL(20, 8) NOT NULL,
    profit_rate DECIMAL(8, 4) NOT NULL,
    trading_fees DECIMAL(20, 8) NOT NULL,
    transfer_fees DECIMAL(20, 8) NOT NULL,
    status ENUM('pending', 'buying', 'transferring', 'selling', 'completed', 'failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    error_message TEXT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (coin_id) REFERENCES coins(id),
    FOREIGN KEY (buy_exchange_id) REFERENCES exchanges(id),
    FOREIGN KEY (sell_exchange_id) REFERENCES exchanges(id),
    INDEX idx_status_created (status, created_at),
    INDEX idx_completed_at (completed_at),
    INDEX idx_trade_history_user_date (user_id, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;



-- ==============================================
-- 6. 실시간 가격 로그 테이블
-- ==============================================
CREATE TABLE IF NOT EXISTS price_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    exchange_id INT NOT NULL,
    coin_id INT NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    volume_24h DECIMAL(20, 8),
    timestamp TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (exchange_id) REFERENCES exchanges(id),
    FOREIGN KEY (coin_id) REFERENCES coins(id),
    INDEX idx_exchange_coin_time (exchange_id, coin_id, timestamp)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ==============================================
-- 기본 데이터 삽입
-- ==============================================

-- 거래소 정보 삽입
INSERT IGNORE INTO exchanges (name, type, api_url, websocket_url, trading_fee_rate) VALUES
('업비트', 'domestic', 'https://api.upbit.com', 'wss://api.upbit.com/websocket/v1', 0.0005),
('빗썸', 'domestic', 'https://api.bithumb.com', NULL, 0.0025),
('코인원', 'domestic', 'https://api.coinone.co.kr', NULL, 0.001),
('바이낸스', 'overseas', 'https://api.binance.com', 'wss://stream.binance.com:9443', 0.001),
('코인베이스', 'overseas', 'https://api.coinbase.com', 'wss://ws-feed.exchange.coinbase.com', 0.005);

-- 암호화폐 정보 삽입
INSERT IGNORE INTO coins (symbol, name, network, withdrawal_fee, min_withdrawal) VALUES
('BTC', 'Bitcoin', 'BTC', 0.0005, 0.001),
('ETH', 'Ethereum', 'ERC20', 0.01, 0.02),
('XRP', 'Ripple', 'XRP', 0.15, 20),
('ADA', 'Cardano', 'ADA', 1, 10),
('DOT', 'Polkadot', 'DOT', 0.1, 1),
('MATIC', 'Polygon', 'MATIC', 0.1, 1),
('SOL', 'Solana', 'SOL', 0.01, 0.02);

-- 봇 기본 설정 삽입
INSERT IGNORE INTO bot_settings (user_id, key_name, value, data_type, description) VALUES
(1, 'search_interval_seconds', '60', 'number', '가격 검색 주기(초)'),
(1, 'premium_threshold_percent', '1.0', 'number', '프리미엄 임계값(%)'),
(1, 'trading_intensity_threshold', '5', 'number', '매수 조건 임계값'),
(1, 'min_trade_amount_krw', '1000000', 'number', '최소 거래 금액(원)'),
(1, 'max_trade_amount_krw', '10000000', 'number', '최대 거래 금액(원)'),
(1, 'max_daily_trades', '20', 'number', '일일 최대 거래 횟수'),
(1, 'bot_enabled', 'false', 'boolean', '봇 활성화 상태'),
(1, 'emergency_stop', 'false', 'boolean', '긴급 정지 플래그');

-- 매매강도 초기화
INSERT IGNORE INTO trading_intensity (coin_id, current_intensity) 
SELECT id, 0 FROM coins WHERE is_active = TRUE;

-- ==============================================
-- 4. 초기 관리자 계정 생성 (실제 운영시 안전한 비밀번호 사용)
-- ==============================================
INSERT IGNORE INTO users (username, password_hash, email, role) VALUES
('admin', '$2b$10$example_hash_for_admin_password', 'admin@coinbot.com', 'admin');

-- ==============================================
-- 초기화 완료 확인
-- ==============================================
SELECT 
    '김프 봇 데이터베이스 초기화 완료!' as message,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'coinbot_dev') as total_tables,
    (SELECT COUNT(*) FROM exchanges) as total_exchanges,
    (SELECT COUNT(*) FROM coins) as total_coins,
    NOW() as initialized_at;

CREATE INDEX idx_uec_user_verified ON user_exchange_credentials(user_id, is_verified);