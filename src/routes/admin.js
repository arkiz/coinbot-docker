// routes/admin.js
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const router = express.Router();
const KimchiMonitoringService = require('../services/KimchiMonitoringService');
const CoinService = require('../services/CoinService');
const UserSettingsService = require('../services/UserSettingsService');
const ApiKeyService = require('../services/ApiKeyService');
const ExchangeManagementService = require('../services/ExchangeManagementService');

// 관리자 권한 확인 미들웨어
function requireAdmin(req, res, next) {
    if (!req.isAuthenticated() || req.user.role !== 'admin') {
        return res.status(403).render('error', {
            title: '접근 거부',
            message: '관리자 권한이 필요합니다.'
        });
    }
    next();
}

// 관리자 대시보드
router.get('/', requireAdmin, async (req, res) => {
    try {
        const connection = await db.getConnection();
        
        // 기본 통계 수집
        const [totalUsers] = await connection.execute('SELECT COUNT(*) as count FROM users');
        const [activeUsers] = await connection.execute('SELECT COUNT(*) as count FROM users WHERE is_active = TRUE');
        const [adminUsers] = await connection.execute('SELECT COUNT(*) as count FROM users WHERE role = "admin"');
        
        // 최근 로그인 사용자
        const [recentLogins] = await connection.execute(`
            SELECT username, email, last_login 
            FROM users 
            WHERE last_login IS NOT NULL 
            ORDER BY last_login DESC 
            LIMIT 5
        `);
        
        connection.release();
        
        // ✅ app.locals에서 kimchiMonitoringService 인스턴스 안전하게 접근
        const kimchiService = req.app.locals.kimchiMonitoringService;
        let monitoringStatus = {
            isRunning: false,
            settings: { searchIntervalSeconds: 60, premiumThresholdPercent: 1.0 },
            coinCount: 5,
            coins: ['BTC', 'ETH', 'XRP', 'ADA', 'DOT'],
            nextExecution: null
        };

        // KimchiMonitoringService가 사용 가능한 경우에만 상태 조회
        if (kimchiService && typeof kimchiService.getStatus === 'function') {
            try {
                monitoringStatus = await kimchiService.getStatus();
            } catch (serviceError) {
                console.error('김프 모니터링 서비스 상태 조회 오류:', serviceError);
            }
        }
        
        // 시스템 상태 정보
        const systemStatus = {
            uptime: Math.floor(process.uptime()),
            nodeVersion: process.version,
            platform: process.platform,
            memoryUsage: process.memoryUsage(),
            timestamp: new Date().toISOString()
        };
        
        res.render('admin/dashboard', {
            title: '관리자 대시보드',
            user: req.user,
            stats: {
                totalUsers: totalUsers[0].count,
                activeUsers: activeUsers[0].count,
                adminUsers: adminUsers[0].count,
                regularUsers: totalUsers[0].count - adminUsers[0].count
            },
            monitoringStatus: monitoringStatus,
            recentLogins: recentLogins,
            systemStatus: systemStatus,
            success: req.flash('success'),
            error: req.flash('error')
        });
        
    } catch (error) {
        console.error('관리자 대시보드 오류:', error);
        
        // 오류 발생 시에도 기본 페이지 렌더링 (사용자 경험 개선)
        res.render('admin/dashboard', {
            title: '관리자 대시보드',
            user: req.user,
            stats: {
                totalUsers: 0,
                activeUsers: 0,
                adminUsers: 0,
                regularUsers: 0
            },
            monitoringStatus: {
                isRunning: false,
                settings: { searchIntervalSeconds: 60 },
                coinCount: 5,
                coins: ['BTC', 'ETH', 'XRP', 'ADA', 'DOT'],
                nextExecution: null
            },
            recentLogins: [],
            systemStatus: {
                uptime: Math.floor(process.uptime()),
                nodeVersion: process.version,
                platform: process.platform,
                timestamp: new Date().toISOString()
            },
            success: req.flash('success'),
            error: req.flash('error')
        });
    }
});

// 김프 모니터링 제어 라우트 추가
router.post('/monitoring/:action', requireAdmin, async (req, res) => {
    const action = req.params.action;
    const kimchiService = req.app.locals.kimchiMonitoringService;
    
    if (!kimchiService) {
        req.flash('error', '김프 모니터링 서비스를 찾을 수 없습니다.');
        return res.redirect('/admin');
    }
    
    try {
        if (action === 'start') {
            const success = await kimchiService.startMonitoring();
            if (success) {
                req.flash('success', '김프 모니터링이 시작되었습니다.');
            } else {
                req.flash('error', '모니터링 시작에 실패했습니다.');
            }
        } else if (action === 'stop') {
            const success = kimchiService.stopMonitoring();
            if (success) {
                req.flash('success', '김프 모니터링이 중지되었습니다.');
            } else {
                req.flash('error', '모니터링 중지에 실패했습니다.');
            }
        }
    } catch (error) {
        console.error(`모니터링 ${action} 오류:`, error);
        req.flash('error', `모니터링 ${action} 중 오류가 발생했습니다.`);
    }
    
    res.redirect('/admin');
});



// 사용자 관리 페이지
router.get('/users', requireAdmin, async (req, res) => {
    try {
        const connection = await db.getConnection();
        const [users] = await connection.execute(
            'SELECT id, username, email, role, is_active, created_at, last_login FROM users ORDER BY created_at DESC'
        );
        connection.release();

        res.render('admin/users', {
            title: '사용자 관리',
            user: req.user,
            users: users,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('사용자 관리 페이지 오류:', error);
        req.flash('error', '사용자 목록을 불러오는 중 오류가 발생했습니다.');
        res.redirect('/admin');
    }
});

// 새 사용자 등록 처리
router.post('/users', requireAdmin, async (req, res) => {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password || !role) {
        req.flash('error', '모든 필드를 입력해주세요.');
        return res.redirect('/admin/users');
    }

    try {
        const connection = await db.getConnection();
        
        // 이메일 중복 확인
        const [existingUser] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            connection.release();
            req.flash('error', '이미 등록된 이메일입니다.');
            return res.redirect('/admin/users');
        }

        // 비밀번호 해싱
        const hashedPassword = await bcrypt.hash(password, 10);

        // 사용자 생성
        await connection.execute(
            'INSERT INTO users (username, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, TRUE, NOW())',
            [username, email, hashedPassword, role]
        );
        connection.release();

        console.log(`새 사용자 등록: ${username} (${email})`);
        req.flash('success', `${username} 사용자가 성공적으로 등록되었습니다.`);
        res.redirect('/admin/users');
    } catch (error) {
        console.error('사용자 등록 오류:', error);
        req.flash('error', '사용자 등록 중 오류가 발생했습니다.');
        res.redirect('/admin/users');
    }
});

// 사용자 상태 토글
router.post('/users/:id/toggle-status', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const connection = await db.getConnection();
        await connection.execute('UPDATE users SET is_active = NOT is_active WHERE id = ?', [userId]);
        connection.release();
        
        req.flash('success', '사용자 상태가 변경되었습니다.');
        res.redirect('/admin/users');
    } catch (error) {
        console.error('사용자 상태 변경 오류:', error);
        req.flash('error', '상태 변경 중 오류가 발생했습니다.');
        res.redirect('/admin/users');
    }
});

// 관리자: 사용자 API 키 테스트 (누락된 라우트)
router.post('/users/:userId/api-keys/:keyId/test', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    const keyId = Number(req.params.keyId);
    
    try {
        const apiKeyService = new ApiKeyService(targetUserId);
        const result = await apiKeyService.testApiKey(keyId);
        
        req.flash(result.success ? 'success' : 'error', result.message);
        
        if (result.success && result.balance) {
            req.flash('success', 
                `잔고 정보: ${result.balance.fiatCurrency} ${result.balance.fiatBalance.toLocaleString()}, ` +
                `코인 ${result.balance.coinBalances.length}종류`
            );
        }
    } catch (error) {
        req.flash('error', `테스트 실패: ${error.message}`);
    }
    res.redirect(`/admin/users/${targetUserId}/api-keys`);
});

// 관리자: 사용자 API 키 삭제 (누락된 라우트)
router.post('/users/:userId/api-keys/:keyId/delete', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    const keyId = Number(req.params.keyId);
    
    try {
        const apiKeyService = new ApiKeyService(targetUserId);
        await apiKeyService.deleteApiKey(keyId);
        req.flash('success', 'API 키가 삭제되었습니다.');
    } catch (error) {
        req.flash('error', `삭제 실패: ${error.message}`);
    }
    res.redirect(`/admin/users/${targetUserId}/api-keys`);
});



// 코인 관리 메인 페이지
router.get('/coins', requireAdmin, async (req, res) => {
    try {
        const [coins, recentLogs] = await Promise.all([
            CoinService.getAllCoins(),
            CoinService.getAllAuditLogs(10)
        ]);

        res.render('admin/coins', {
            title: '코인 관리',
            user: req.user,
            coins: coins,
            recentLogs: recentLogs,
            editCoin: null,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('코인 관리 페이지 오류:', error);
        req.flash('error', '코인 목록을 불러오는 중 오류가 발생했습니다.');
        res.redirect('/admin');
    }
});

// 코인 수정 페이지
router.get('/coins/edit/:id', requireAdmin, async (req, res) => {
    try {
        const [coin, allCoins, recentLogs] = await Promise.all([
            CoinService.getCoinById(req.params.id),
            CoinService.getAllCoins(),
            CoinService.getAllAuditLogs(10)
        ]);

        if (!coin) {
            req.flash('error', '코인을 찾을 수 없습니다.');
            return res.redirect('/admin/coins');
        }

        res.render('admin/coins', {
            title: `코인 수정 - ${coin.symbol}`,
            user: req.user,
            coins: allCoins,
            recentLogs: recentLogs,
            editCoin: coin,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error(`코인 수정 페이지 오류 (ID: ${req.params.id}):`, error);
        req.flash('error', '코인 정보를 불러오는 중 오류가 발생했습니다.');
        res.redirect('/admin/coins');
    }
});

// 새 코인 추가 처리
router.post('/coins', requireAdmin, async (req, res) => {
    try {
        const coinData = {
            symbol: req.body.symbol?.trim().toUpperCase(),
            name: req.body.name?.trim(),
            network: req.body.network?.trim(),
            upbit_market: req.body.upbit_market?.trim() || `KRW-${req.body.symbol?.trim().toUpperCase()}`,
            binance_symbol: req.body.binance_symbol?.trim() || `${req.body.symbol?.trim().toUpperCase()}USDT`,
            withdrawal_fee: req.body.withdrawal_fee,
            min_withdrawal: req.body.min_withdrawal,
            description: req.body.description?.trim(),
            website_url: req.body.website_url?.trim(),
            is_active: req.body.is_active === 'true',
            is_tradable: req.body.is_tradable === 'true'
        };

        // 필수 필드 검증
        if (!coinData.symbol || !coinData.name || !coinData.network) {
            req.flash('error', '심볼, 이름, 네트워크는 필수 입력 항목입니다.');
            return res.redirect('/admin/coins');
        }

        await CoinService.createCoin(req.user.id, coinData);

        console.log(`관리자 ${req.user.username}이 새 코인 추가: ${coinData.symbol}`);
        req.flash('success', `${coinData.symbol} 코인이 성공적으로 추가되었습니다.`);
        res.redirect('/admin/coins');
    } catch (error) {
        console.error('코인 추가 오류:', error);
        req.flash('error', `코인 추가 중 오류가 발생했습니다: ${error.message}`);
        res.redirect('/admin/coins');
    }
});

// 코인 수정 처리
router.post('/coins/:id', requireAdmin, async (req, res) => {
    const coinId = req.params.id;
    
    try {
        const coinData = {
            symbol: req.body.symbol?.trim().toUpperCase(),
            name: req.body.name?.trim(),
            network: req.body.network?.trim(),
            upbit_market: req.body.upbit_market?.trim(),
            binance_symbol: req.body.binance_symbol?.trim(),
            withdrawal_fee: req.body.withdrawal_fee,
            min_withdrawal: req.body.min_withdrawal,
            description: req.body.description?.trim(),
            website_url: req.body.website_url?.trim(),
            is_active: req.body.is_active === 'true',
            is_tradable: req.body.is_tradable === 'true'
        };

        await CoinService.updateCoin(req.user.id, coinId, coinData);

        console.log(`관리자 ${req.user.username}이 코인 수정: ${coinData.symbol} (ID: ${coinId})`);
        req.flash('success', `${coinData.symbol} 코인이 성공적으로 수정되었습니다.`);
        res.redirect('/admin/coins');
    } catch (error) {
        console.error(`코인 수정 오류 (ID: ${coinId}):`, error);
        req.flash('error', `코인 수정 중 오류가 발생했습니다: ${error.message}`);
        res.redirect('/admin/coins');
    }
});

// 코인 상태 토글
router.post('/coins/:id/toggle/:field', requireAdmin, async (req, res) => {
    const coinId = req.params.id;
    const field = req.params.field;

    try {
        await CoinService.toggleCoinStatus(req.user.id, coinId, field);

        const fieldName = field === 'is_active' ? '활성 상태' : '거래 가능 상태';
        console.log(`관리자 ${req.user.username}이 코인 ${fieldName} 토글: ID ${coinId}`);
        req.flash('success', `코인 ${fieldName}가 변경되었습니다.`);
        res.redirect('/admin/coins');
    } catch (error) {
        console.error(`코인 상태 토글 오류 (ID: ${coinId}, field: ${field}):`, error);
        req.flash('error', `코인 상태 변경 중 오류가 발생했습니다: ${error.message}`);
        res.redirect('/admin/coins');
    }
});

// 코인 변경 이력 조회
router.get('/coins/:id/audit', requireAdmin, async (req, res) => {
    const coinId = req.params.id;

    try {
        const [coin, auditLogs] = await Promise.all([
            CoinService.getCoinById(coinId),
            CoinService.getCoinAuditLogs(coinId, 50)
        ]);

        if (!coin) {
            req.flash('error', '코인을 찾을 수 없습니다.');
            return res.redirect('/admin/coins');
        }

        res.render('admin/coin-audit', {
            title: `${coin.symbol} 변경 이력`,
            user: req.user,
            coin: coin,
            auditLogs: auditLogs,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error(`코인 감사 로그 조회 오류 (ID: ${coinId}):`, error);
        req.flash('error', '변경 이력을 불러오는 중 오류가 발생했습니다.');
        res.redirect('/admin/coins');
    }
});


// 사용자별 API 키 관리
router.get('/users/:userId/api-keys', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    const apiKeyService = new ApiKeyService(targetUserId);
    
    const [apiKeys, exchanges, user] = await Promise.all([
        apiKeyService.getUserApiKeys(),
        getExchanges(),
        getUserById(targetUserId)
    ]);

    res.render('admin/user-api-keys', {
        title: `${user.username}님의 API 키 관리`,
        user: req.user,
        targetUser: user,
        apiKeys,
        exchanges,
        success: req.flash('success'),
        error: req.flash('error')
    });
});

// 관리자가 사용자 API 키 저장
router.post('/users/:userId/api-keys', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    const apiKeyService = new ApiKeyService(targetUserId);
    
    try {
        const { exchange_id, api_key, secret_key, passphrase } = req.body;
        await apiKeyService.saveApiKey(exchange_id, api_key, secret_key, passphrase);
        req.flash('success', 'API 키가 저장되었습니다.');
    } catch (error) {
        req.flash('error', `저장 실패: ${error.message}`);
    }
    res.redirect(`/admin/users/${targetUserId}/api-keys`);
});

// 관리자: 사용자 입금주소 관리
router.get('/users/:userId/deposit-addresses', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    
    try {
        const settingsService = new UserSettingsService(targetUserId);
        const [addresses, exchanges, coins, targetUser] = await Promise.all([
            settingsService.getAllDepositAddresses(),
            getActiveExchanges(),
            getTradableCoins(),
            getUserById(targetUserId)
        ]);

        res.render('admin/user-deposit-addresses', {
            title: `${targetUser.username}님의 입금주소 관리`,
            user: req.user,
            targetUser,
            addresses,
            exchanges,
            coins,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('관리자 입금주소 페이지 오류:', error);
        req.flash('error', '입금주소 관리 페이지를 불러오는 중 오류가 발생했습니다.');
        res.redirect('/admin/users');
    }
});

// 관리자: 사용자 입금주소 저장
router.post('/users/:userId/deposit-addresses', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    
    try {
        const { exchange_id, symbol, address, memo } = req.body;
        const settingsService = new UserSettingsService(targetUserId);
        
        await settingsService.upsertDepositAddress(
            Number(exchange_id), 
            symbol, 
            address, 
            memo || ''
        );
        
        req.flash('success', '입금주소가 저장되었습니다.');
    } catch (error) {
        req.flash('error', `저장 실패: ${error.message}`);
    }
    res.redirect(`/admin/users/${targetUserId}/deposit-addresses`);
});

// 관리자: 사용자 입금주소 삭제
router.post('/users/:userId/deposit-addresses/:exchangeId/:symbol/delete', requireAdmin, async (req, res) => {
    const targetUserId = Number(req.params.userId);
    const { exchangeId, symbol } = req.params;
    
    try {
        const settingsService = new UserSettingsService(targetUserId);
        await settingsService.deleteDepositAddress(Number(exchangeId), symbol);
        req.flash('success', '입금주소가 삭제되었습니다.');
    } catch (error) {
        req.flash('error', `삭제 실패: ${error.message}`);
    }
    res.redirect(`/admin/users/${targetUserId}/deposit-addresses`);
});

// 거래소 관리 페이지
router.get('/exchanges', requireAdmin, async (req, res) => {
    try {
        const exchanges = await ExchangeManagementService.getAllExchanges();
        
        res.render('admin/exchanges', {
            title: '거래소 관리',
            user: req.user,
            exchanges: exchanges,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('거래소 관리 페이지 오류:', error);
        req.flash('error', '거래소 목록을 불러오는 중 오류가 발생했습니다.');
        res.redirect('/admin');
    }
});

// 거래소 추가 처리
router.post('/exchanges', requireAdmin, async (req, res) => {
    try {
        const exchangeData = {
            name: req.body.name?.trim(),
            type: req.body.type,
            api_url: req.body.api_url?.trim(),
            websocket_url: req.body.websocket_url?.trim(),
            trading_fee_rate: req.body.trading_fee_rate,
            withdrawal_fee_rate: req.body.withdrawal_fee_rate
        };

        // 필수 필드 검증
        if (!exchangeData.name || !exchangeData.type || !exchangeData.api_url) {
            req.flash('error', '거래소명, 타입, API URL은 필수 입력 항목입니다.');
            return res.redirect('/admin/exchanges');
        }

        await ExchangeManagementService.createExchange(exchangeData);
        
        console.log(`관리자 ${req.user.username}이 새 거래소 추가: ${exchangeData.name}`);
        req.flash('success', `${exchangeData.name} 거래소가 성공적으로 추가되었습니다.`);
        
    } catch (error) {
        console.error('거래소 추가 오류:', error);
        req.flash('error', `거래소 추가 중 오류가 발생했습니다: ${error.message}`);
    }
    
    res.redirect('/admin/exchanges');
});

// 거래소 수정 처리
router.post('/exchanges/:id', requireAdmin, async (req, res) => {
    const exchangeId = Number(req.params.id);
    
    try {
        const exchangeData = {
            name: req.body.name?.trim(),
            type: req.body.type,
            api_url: req.body.api_url?.trim(),
            websocket_url: req.body.websocket_url?.trim(),
            trading_fee_rate: req.body.trading_fee_rate,
            withdrawal_fee_rate: req.body.withdrawal_fee_rate
        };

        await ExchangeManagementService.updateExchange(exchangeId, exchangeData);
        
        console.log(`관리자 ${req.user.username}이 거래소 수정: ${exchangeData.name} (ID: ${exchangeId})`);
        req.flash('success', `${exchangeData.name} 거래소가 성공적으로 수정되었습니다.`);
        
    } catch (error) {
        console.error(`거래소 수정 오류 (ID: ${exchangeId}):`, error);
        req.flash('error', `거래소 수정 중 오류가 발생했습니다: ${error.message}`);
    }
    
    res.redirect('/admin/exchanges');
});

// 거래소 상태 토글
router.post('/exchanges/:id/toggle-status', requireAdmin, async (req, res) => {
    const exchangeId = Number(req.params.id);
    
    try {
        const newStatus = await ExchangeManagementService.toggleExchangeStatus(exchangeId);
        
        console.log(`관리자 ${req.user.username}이 거래소 상태 변경: ID ${exchangeId} → ${newStatus ? '활성' : '비활성'}`);
        req.flash('success', `거래소 상태가 ${newStatus ? '활성화' : '비활성화'}되었습니다.`);
        
    } catch (error) {
        console.error(`거래소 상태 토글 오류 (ID: ${exchangeId}):`, error);
        req.flash('error', `상태 변경 중 오류가 발생했습니다: ${error.message}`);
    }
    
    res.redirect('/admin/exchanges');
});

// 거래소 삭제
router.post('/exchanges/:id/delete', requireAdmin, async (req, res) => {
    const exchangeId = Number(req.params.id);
    
    try {
        await ExchangeManagementService.deleteExchange(exchangeId);
        
        console.log(`관리자 ${req.user.username}이 거래소 삭제: ID ${exchangeId}`);
        req.flash('success', '거래소가 삭제되었습니다.');
        
    } catch (error) {
        console.error(`거래소 삭제 오류 (ID: ${exchangeId}):`, error);
        req.flash('error', `삭제 중 오류가 발생했습니다: ${error.message}`);
    }
    
    res.redirect('/admin/exchanges');
});

// 기본 거래소 초기화 (개발용)
router.post('/exchanges/initialize', requireAdmin, async (req, res) => {
    try {
        const result = await ExchangeManagementService.initializeDefaultExchanges();
        
        if (result) {
            console.log(`관리자 ${req.user.username}이 기본 거래소 초기화 실행`);
            req.flash('success', '기본 거래소 데이터가 생성되었습니다.');
        } else {
            req.flash('error', '거래소 데이터가 이미 존재합니다.');
        }
        
    } catch (error) {
        console.error('거래소 초기화 오류:', error);
        req.flash('error', `초기화 중 오류가 발생했습니다: ${error.message}`);
    }
    
    res.redirect('/admin/exchanges');
});

// 헬퍼 함수들 추가
async function getUserById(userId) {
    const connection = await db.getConnection();
    const [rows] = await connection.execute(`
        SELECT id, username, email FROM users WHERE id = ?
    `, [userId]);
    connection.release();
    return rows[0];
}

async function getActiveExchanges() {
    const connection = await db.getConnection();
    const [rows] = await connection.execute(`
        SELECT id, name, type FROM exchanges 
        WHERE is_active = TRUE 
        ORDER BY type, name
    `);
    connection.release();
    return rows;
}

async function getTradableCoins() {
    const connection = await db.getConnection();
    const [rows] = await connection.execute(`
        SELECT symbol, name FROM coins 
        WHERE is_active = TRUE AND is_tradable = TRUE 
        ORDER BY symbol
    `);
    connection.release();
    return rows;
}

async function getExchanges() {
//     const connection = await db.getConnection();
//     const [rows] = await connection.execute(`
//         SELECT id, name, type FROM exchanges 
//         WHERE name IN ('업비트', '바이낸스') AND is_active = TRUE 
//         ORDER BY type, name
//     `);
//     connection.release();
//     return rows;
    const ExchangeManagementService = require('../services/ExchangeManagementService');
    return await ExchangeManagementService.getActiveExchanges();
}

module.exports = router;