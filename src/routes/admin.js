// routes/admin.js
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/database');
const router = express.Router();
const KimchiMonitoringService = require('../services/KimchiMonitoringService');
const CoinService = require('../services/CoinService');

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
                monitoringStatus = kimchiService.getStatus();
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

module.exports = router;