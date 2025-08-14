const UpbitServiceClass = require('./services/UpbitService');
const BinanceServiceClass = require('./services/BinanceService');
const ExchangeRateServiceClass = require('./services/ExchangeRateService');
const KimchiMonitoringServiceClass = require('./services/KimchiMonitoringService');
const TimeUtilsClass = require('./services/TimeUtils');


// create instance
const upbitService = new UpbitServiceClass();
const binanceService = new BinanceServiceClass();
const exchangeRateService = new ExchangeRateServiceClass();
const kimchiMonitoringService = new KimchiMonitoringServiceClass(upbitService, binanceService, exchangeRateService);
const timeUtils = new TimeUtilsClass();

const express = require('express');
const cors = require('cors');
// const mysql = require('mysql2/promise');
const db = require('./config/database'); // 프로미스 풀 (기본 export)
const Redis = require('ioredis');
const winston = require('winston');
const path = require('path');

const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const passport = require('passport');
const flash = require('connect-flash');

const app = express();
const PORT = process.env.PORT || 3000;

// set logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: () => timeUtils.getLogTimestamp()
        }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            return `${timestamp} [${level.toUpperCase()}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        }),
        new winston.transports.File({ 
            filename: 'logs/error.log', 
            level: 'error' 
        }),
        new winston.transports.File({ 
            filename: 'logs/combined.log' 
        })
    ]
});

// set dbconfig
// const dbConfig = {
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME,
//     charset: 'utf8mb4',
//     waitForConnections: true,
//     connectionLimit: 10,
//     queueLimit: 0
// };
// const db = mysql.createPool(dbConfig);

// set redis
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
});

// set middleware 
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// app.use(express.static('public'));
app.use(express.static(path.join(__dirname, 'public')));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

const sessionStore = new MySQLStore({
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000, // 15분
    expiration: 24 * 60 * 60 * 1000, // 24시간
    createDatabaseTable: true
}, db.pool);

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

app.use('/auth', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/dashboard', require('./routes/dashboard'));


// event listner for Redis 
redis.on('connect', () => {
    logger.info('Redis 연결 성공');
});

redis.on('error', (err) => {
    logger.error('Redis 연결 오류:', err.message);
});

// dashboard set
app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
        if (req.user.role === 'admin') {
            res.redirect('/admin');
        } else {
            res.redirect('/dashboard');
        }
    } else {
        res.redirect('/auth/login');
    }
});
// app.get('/', (req, res) => {
//     try {
//         const timeInfo = timeUtils.getTradingTimeInfo();
        
//         res.render('dashboard', {
//             title: '김프 차익거래 봇 대시보드',
//             serverTime: timeInfo,
//             version: '1.0.0'
//         });
//     } catch (error) {
//         logger.error('대시보드 렌더링 실패', { error: error.message });
//         res.status(500).json({
//             error: '대시보드를 불러올 수 없습니다.',
//             message: error.message
//         });
//     }
// });

// health check
app.get('/health', async (req, res) => {
    const healthStatus = {
        status: 'healthy',
        timestamp: timeUtils.now(),
        services: {},
        database_test: {}
    };

    try {
        // Test connect MySQL
        const connection = await db.getConnection();
        await connection.execute('SELECT 1 as test');
        healthStatus.services.mysql = 'connected';
        
        const [rows] = await connection.execute(
            'SELECT key_name, description FROM bot_settings WHERE key_name = ? LIMIT 1',
            ['search_interval_seconds']
        );
        
        if (rows.length > 0) {
            healthStatus.database_test = {
                korean_text: rows[0].description,
                encoding_test: 'success'
            };
        }
        await connection.end();
        
        // Test connect Redis
        await redis.ping();
        healthStatus.services.redis = 'connected';
        
        logger.info('헬스체크 성공');
        res.json(healthStatus);
        
    } catch (error) {
        healthStatus.status = 'unhealthy';
        healthStatus.error = error.message;
        
        // check services
        try {
            const connection = await db.getConnection();
            await connection.execute('SELECT 1');
            await connection.end();
            healthStatus.services.mysql = 'connected';
        } catch (dbError) {
            healthStatus.services.mysql = 'disconnected';
        }
        
        try {
            await redis.ping();
            healthStatus.services.redis = 'connected';
        } catch (redisError) {
            healthStatus.services.redis = 'disconnected';
        }
        
        logger.error('헬스체크 실패:', error.message);
        res.status(500).json(healthStatus);
    }
});


app.get('/api/status', (req, res) => {
    res.json({
        message: '🤖 김프 차익거래 봇 API 서버가 실행 중입니다!',
        version: '1.0.0',
        status: 'running',
        timestamp: timeUtils.now()
    });
});

// 봇 상태 확인 라우트 (향후 확장 예정)
app.get('/bot/status', (req, res) => {
    res.json({
        bot_status: 'stopped',
        last_check: null,
        active_trades: 0,
        message: '봇 기능은 아직 구현되지 않았습니다.'
    });
});

app.get('/api/test/exchanges', async (req, res) => {
    try {
        const testResults = {
            timestamp: timeUtils.now(),
            tests: {},
            message: '거래소 API 연동 테스트'
        };

        // 업비트 BTC 테스트
        try {
            const upbitBtc = await upbitService.getTicker('KRW-BTC');
            const upbitOrderbook = await upbitService.getOrderbook('KRW-BTC', 5);
            testResults.tests.upbit = {
                status: 'success',
                ticker: upbitBtc,
                orderbook: {
                    askAverage: upbitService.calculateAveragePrice(upbitOrderbook, 'ask'),
                    bidAverage: upbitService.calculateAveragePrice(upbitOrderbook, 'bid')
                }
            };
        } catch (error) {
            testResults.tests.upbit = {
                status: 'error',
                error: error.message
            };
        }

        // 바이낸스 BTC 테스트
        try {
            const binanceBtc = await binanceService.getTicker('BTCUSDT');
            const binanceOrderbook = await binanceService.getOrderbook('BTCUSDT', 5);
            testResults.tests.binance = {
                status: 'success',
                ticker: binanceBtc,
                orderbook: {
                    askAverage: binanceService.calculateAveragePrice(binanceOrderbook, 'ask'),
                    bidAverage: binanceService.calculateAveragePrice(binanceOrderbook, 'bid')
                }
            };
        } catch (error) {
            testResults.tests.binance = {
                status: 'error',
                error: error.message
            };
        }

        // 환율 테스트
        try {
            const exchangeRate = await exchangeRateService.getUsdKrwRate();
            testResults.tests.exchangeRate = {
                status: 'success',
                data: exchangeRate
            };
        } catch (error) {
            testResults.tests.exchangeRate = {
                status: 'error',
                error: error.message
            };
        }

        // 김프 계산 테스트 (기본적인 계산)
        if (testResults.tests.upbit.status === 'success' && 
            testResults.tests.binance.status === 'success' && 
            testResults.tests.exchangeRate.status === 'success') {
            
            const upbitPrice = testResults.tests.upbit.ticker.price;
            const binancePrice = testResults.tests.binance.ticker.price;
            const usdKrwRate = testResults.tests.exchangeRate.data.rate;
            
            const binancePriceKrw = binancePrice * usdKrwRate;
            const premium = ((upbitPrice - binancePriceKrw) / binancePriceKrw) * 100;
            
            testResults.kimchiPremium = {
                upbitPrice,
                binancePriceUsd: binancePrice,
                binancePriceKrw,
                usdKrwRate,
                premiumPercent: premium.toFixed(4)
            };
        }

        testResults.serverInfo = {
            tradingTimeInfo: timeUtils.getTradingTimeInfo(),
            timezone: 'Asia/Seoul (KST, UTC+9)'
        };

        logger.info('거래소 API 테스트 완료', testResults);
        res.json(testResults);

    } catch (error) {
        logger.error('거래소 API 테스트 실패', { error: error.message });
        res.status(500).json({
            error: 'API 테스트 중 오류가 발생했습니다.',
            message: error.message,
            timestamp: timeUtils.now()
        });
    }
});




// 모니터링 결과 조회
app.get('/api/monitoring/results', async (req, res) => {
    try {
        const results = await kimchiMonitoringService.getLatestResults();
        if (results) {
            res.json({
                status: 'success',
                data: results,
                timestamp: timeUtils.now()
            });
        } else {
            res.status(404).json({
                error: '모니터링 결과를 찾을 수 없습니다.',
                message: '모니터링을 시작한 후 다시 시도해주세요.',
                timestamp: timeUtils.now()
            });
        }
    } catch (error) {
        logger.error('모니터링 결과 조회 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});


// ============================================
// 김프 모니터링 관리 API
// ============================================

// 모니터링 상태 확인
app.get('/api/monitoring/status', (req, res) => {
    try {
        const status = kimchiMonitoringService.getStatus();
        const timeInfo = timeUtils.getTradingTimeInfo();

        res.json({
            ...status,
            serverTime: timeInfo,
            nextExecution: status.isRunning ? 
                timeUtils.utcToKst(new Date(Date.now() + status.settings.searchIntervalSeconds * 1000)) : 
                null,
            timezone: 'Asia/Seoul (KST, UTC+9)'
        });
    } catch (error) {
        logger.error('모니터링 상태 조회 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// 모니터링 시작
app.post('/api/monitoring/start', async (req, res) => {
    try {
        const success = await kimchiMonitoringService.startMonitoring();
        if (success) {
            logger.info('김프 모니터링 시작 요청 성공');
            res.json({
                message: '김프 모니터링이 시작되었습니다.',
                status: kimchiMonitoringService.getStatus(),
                timestamp: timeUtils.now()
            });
        } else {
            res.status(400).json({
                error: '모니터링 시작에 실패했습니다.',
                timestamp: timeUtils.now()
            });
        }
    } catch (error) {
        logger.error('모니터링 시작 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// 모니터링 중지
app.post('/api/monitoring/stop', (req, res) => {
    try {
        const success = kimchiMonitoringService.stopMonitoring();
        if (success) {
            logger.info('김프 모니터링 중지 요청 성공');
            res.json({
                message: '김프 모니터링이 중지되었습니다.',
                status: kimchiMonitoringService.getStatus(),
                timestamp: timeUtils.now()
            });
        } else {
            res.status(400).json({
                error: '모니터링이 실행 중이 아닙니다.',
                timestamp: timeUtils.now()
            });
        }
    } catch (error) {
        logger.error('모니터링 중지 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// 수동 모니터링 실행 (테스트용)
app.post('/api/monitoring/run-once', async (req, res) => {
    try {
        logger.info('수동 모니터링 실행 요청');
        const summary = await kimchiMonitoringService.monitorAllCoins();
        res.json({
            message: '수동 모니터링 실행 완료',
            result: summary,
            timestamp: timeUtils.now()
        });
    } catch (error) {
        logger.error('수동 모니터링 실행 실패', { error: error.message });
        res.status(500).json({ 
            error: '수동 모니터링 실행 중 오류가 발생했습니다.',
            message: error.message,
            timestamp: timeUtils.now()
        });
    }
});

// 특정 코인의 실시간 김프 조회
app.get('/api/monitoring/coin/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const coinMapping = kimchiMonitoringService.coinMappings.find(
            c => c.symbol.toLowerCase() === symbol.toLowerCase()
        );
        
        if (!coinMapping) {
            return res.status(404).json({
                error: `지원하지 않는 코인입니다: ${symbol}`,
                supportedCoins: kimchiMonitoringService.coinMappings.map(c => c.symbol),
                timestamp: timeUtils.now()
            });
        }

        logger.info(`${symbol} 실시간 김프 조회 요청`);
        const result = await kimchiMonitoringService.calculateCoinPremium(coinMapping);
        
        if (result) {
            res.json({
                ...result,
                timestamp: timeUtils.utcToKst(result.timestamp),
                requestedAt: timeUtils.now()
            });
        } else {
            res.status(500).json({
                error: `${symbol} 김프 계산에 실패했습니다.`,
                timestamp: timeUtils.now()
            });
        }
    } catch (error) {
        logger.error(`코인별 김프 조회 실패: ${req.params.symbol}`, { error: error.message });
        res.status(500).json({ error: error.message });
    }
});


// 거래 기회 목록 조회 (매매강도 5 이상인 경우들)
app.get('/api/monitoring/opportunities', async (req, res) => {
    try {
        // Redis에서 거래 기회 목록 조회
        const opportunities = await kimchiMonitoringService.redis.lrange('trading_opportunities', 0, -1);
        const parsedOpportunities = opportunities.map(op => JSON.parse(op));
        
        // 현재 매매강도가 임계값 이상인 코인들 조회
        const connection = await db.getConnection();
        
        const [currentSignals] = await connection.execute(
            `SELECT c.symbol, ti.current_intensity, ti.last_premium_rate, ti.last_updated 
             FROM trading_intensity ti 
             JOIN coins c ON ti.coin_id = c.id 
             WHERE ti.current_intensity >= ? AND c.is_active = TRUE
             ORDER BY ti.current_intensity DESC, ti.last_updated DESC`,
            [kimchiMonitoringService.settings.tradingIntensityThreshold]
        );
        await connection.end();

        res.json({
            currentSignals: currentSignals,
            recentOpportunities: parsedOpportunities,
            threshold: kimchiMonitoringService.settings.tradingIntensityThreshold,
            timestamp: timeUtils.now()
        });
    } catch (error) {
        logger.error('거래 기회 조회 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// 봇 설정 조회
app.get('/api/settings', async (req, res) => {
    try {
        const connection = await db.getConnection();
        
        const [rows] = await connection.execute(
            `SELECT key_name, value, data_type, description 
            FROM bot_settings 
            WHERE is_active = TRUE 
            ORDER BY key_name`
        );
        await connection.end();

        const settings = {};
        rows.forEach(row => {
            let parsedValue = row.value;
            
            // 데이터 타입에 따른 형변환
            if (row.data_type === 'number') {
                parsedValue = parseFloat(row.value);
            } else if (row.data_type === 'boolean') {
                parsedValue = row.value === 'true';
            } else if (row.data_type === 'json') {
                try {
                    parsedValue = JSON.parse(row.value);
                } catch (e) {
                    parsedValue = row.value;
                }
            }
            
            settings[row.key_name] = {
                value: parsedValue,
                description: row.description,
                type: row.data_type
            };
        });

        res.json({
            settings: settings,
            timestamp: timeUtils.now()
        });
    } catch (error) {
        logger.error('봇 설정 조회 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// 통합 대시보드 API (모든 정보를 한 번에)
app.get('/api/dashboard', async (req, res) => {
    try {
        logger.info('통합 대시보드 데이터 요청');
        
        // 병렬로 모든 데이터 수집
        const [monitoringResults, opportunities] = await Promise.allSettled([
            kimchiMonitoringService.getLatestResults(),
            kimchiMonitoringService.redis.lrange('trading_opportunities', 0, 9) // 최근 10개
        ]);

        const dashboard = {
            timestamp: timeUtils.now(),
            status: kimchiMonitoringService.getStatus(),
            monitoring: monitoringResults.status === 'fulfilled' ? monitoringResults.value : null,
            recentOpportunities: opportunities.status === 'fulfilled' ? 
                opportunities.value.map(op => JSON.parse(op)) : [],
            serverInfo: {
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: process.platform
            }
        };

        res.json(dashboard);
    } catch (error) {
        logger.error('대시보드 데이터 조회 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});


// 거래 최적 시간 분석
app.get('/api/trading/time-analysis', (req, res) => {
    try {
        const timeInfo = timeUtils.getTradingTimeInfo();
        const hour = timeInfo.hour;
        
        let recommendation = {};
        
        if (hour >= 9 && hour <= 11) {
            recommendation = {
                level: 'high_activity',
                reason: '한국 주식시장 개장 시간으로 거래량 증가 예상',
                color: 'green'
            };
        } else if (hour >= 21 && hour <= 23) {
            recommendation = {
                level: 'moderate_activity', 
                reason: '미국 시장 개장으로 글로벌 거래량 증가',
                color: 'yellow'
            };
        } else if (hour >= 0 && hour <= 6) {
            recommendation = {
                level: 'low_activity',
                reason: '새벽 시간대로 상대적으로 조용한 시간',
                color: 'blue'
            };
        } else {
            recommendation = {
                level: 'normal_activity',
                reason: '일반적인 거래 시간대',
                color: 'gray'
            };
        }

        res.json({
            timeInfo,
            recommendation,
            marketHours: {
                korean: { start: 9, end: 18, active: timeInfo.isKoreanTradingHours },
                crypto: { start: 8, end: 24, active: timeInfo.isCryptoActiveHours }
            }
        });
    } catch (error) {
        logger.error('거래 시간 분석 실패', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});



// 404 핸들러
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `경로 '${req.path}'를 찾을 수 없습니다.`,
        timestamp: timeUtils.now()
    });
});

// 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
    logger.error('서버 에러:', err.message);
    res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
        timestamp: timeUtils.now()
    });
});

app.locals.formatNumber = function(value, decimals = 2) {
    const num = parseFloat(value);
    return isNaN(num) ? '-' : num.toFixed(decimals);
};

app.locals.formatCurrency = function(amount) {
    const num = parseFloat(amount);
    if (isNaN(num)) return '₩0';
    
    const formatted = num.toLocaleString('ko-KR');
    let unit = '';
    
    if (num >= 100000000) {
        unit = ` (${Math.floor(num / 100000000)}억${num % 100000000 >= 10000000 ? ' ' + Math.floor((num % 100000000) / 10000000) + '천만' : ''}원)`;
    } else if (num >= 10000000) {
        unit = ` (${Math.floor(num / 10000000)}천만원)`;
    } else if (num >= 1000000) {
        unit = ` (${Math.floor(num / 1000000)}백만원)`;
    } else if (num >= 10000) {
        unit = ` (${Math.floor(num / 10000)}만원)`;
    }
    
    return `₩${formatted}${unit}`;
};

kimchiMonitoringService.startMonitoring();

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 김프 봇 서버가 포트 ${PORT}에서 실행 중입니다.`);
    logger.info(`📊 대시보드: http://localhost:${PORT}`);
    logger.info(`🔍 헬스체크: http://localhost:${PORT}/health`);
    logger.info(`🤖 봇 상태: http://localhost:${PORT}/bot/status`);
});

// 안전한 종료 처리
process.on('SIGINT', async () => {
    logger.info('🛑 서버 종료 신호를 받았습니다...');
    
    try {
        await redis.quit();
        logger.info('Redis 연결이 안전하게 종료되었습니다.');
    } catch (error) {
        logger.error('Redis 종료 중 오류:', error.message);
    }
        
    try {
        await db.end(); // ✅ DB 연결 풀 종료
        logger.info('MySQL 연결 풀이 안전하게 종료되었습니다.');
    } catch (error) {
        logger.error('MySQL 연결 풀 종료 중 오류:', error.message);
    }
    
    logger.info('서버가 안전하게 종료되었습니다.');
    process.exit(0);
});

// 예상치 못한 에러 처리
process.on('unhandledRejection', (reason, promise) => {
    logger.error('처리되지 않은 Promise 거부:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('처리되지 않은 예외:', error);
    process.exit(1);
});
