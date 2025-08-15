// routes/dashboard.js
const express = require('express');
const UserBotService = require('../services/UserBotService');
const db = require('../config/database');
const router = express.Router();
const ApiKeyService = require('../services/ApiKeyService');
const UserSettingsService = require('../services/UserSettingsService');
const TradeExecutionService = require('../services/TradeExecutionService');

// 인증 미들웨어
function requireAuth(req, res, next) {
    if (!req.isAuthenticated()) {
        req.flash('error', '로그인이 필요합니다.');
        return res.redirect('/auth/login');
    }
    next();
}

// 사용자 대시보드
router.get('/', requireAuth, async (req, res) => {
    try {
        const userBotService = new UserBotService(req.user.id);
        
        const [botSettings, exchangeBalances, tradingIntensity, tradeHistory] = await Promise.all([
            userBotService.getBotSettings(),
            userBotService.getExchangeBalances(),
            userBotService.getTradingIntensity(),
            userBotService.getTradeHistory(10)
        ]);

        res.render('dashboard', {
            title: `${req.user.username}님의 김프 봇 대시보드`,
            user: req.user,
            botSettings: botSettings,
            exchangeBalances: exchangeBalances,
            tradingIntensity: tradingIntensity,
            tradeHistory: tradeHistory,
            success: req.flash('success'),
            error: req.flash('error')
        });
        console.log('사용자 대시보드 render:', [botSettings, exchangeBalances, tradingIntensity, tradeHistory]);
    } catch (error) {
        console.error('사용자 대시보드 오류:', error);
        req.flash('error', '대시보드를 불러오는 중 오류가 발생했습니다.');
        
        // ✅ 오류 시 기본 빈 설정 상태로 렌더링
        res.render('user/dashboard', {
            title: `${req.user.username}님의 김프 봇 대시보드`,
            user: req.user,
            botSettings: {
                hasSettings: false,
                isComplete: false,
                settingsCount: 0,
                totalRequired: 5,
                search_interval_seconds: null,
                premium_threshold_percent: null,
                trading_intensity_threshold: null,
                min_trade_amount_krw: null,
                max_trade_amount_krw: null,
                bot_enabled: false,
                defaults: {
                    search_interval_seconds: 60,
                    premium_threshold_percent: 1.0,
                    trading_intensity_threshold: 5,
                    min_trade_amount_krw: 1000000,
                    max_trade_amount_krw: 10000000,
                    bot_enabled: false
                }
            },
            tradingIntensity: [],
            tradeHistory: [],
            success: req.flash('success'),
            error: req.flash('error')
        });
    }
});

// ✅ 새로운 GET 라우트: 봇 설정 페이지 표시
router.get('/settings', requireAuth, async (req, res) => {
    try {
        const userBotService = new UserBotService(req.user.id);
        const botSettings = await userBotService.getBotSettings();

        console.log(`사용자 ${req.user.username} 설정 페이지 접근`);
        
        res.render('user/settings', {
            title: `${req.user.username}님의 봇 설정`,
            user: req.user,
            botSettings: botSettings,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('봇 설정 페이지 로드 오류:', error);
        req.flash('error', '봇 설정을 불러오는 중 오류가 발생했습니다.');
        res.redirect('/dashboard');
    }
});

// ✅ 개선된 POST 라우트: 값 검증 및 정규화 포함
router.post('/settings', requireAuth, async (req, res) => {
    try {
        console.log(`사용자 ${req.user.username} 봇 설정 업데이트 요청:`, req.body);
        
        const userBotService = new UserBotService(req.user.id);
        
        // ✅ 서버 측 입력값 검증 및 정규화
        const normalizeValue = (value, defaultVal, isNumber = true) => {
            if (value === undefined || value === null || value === '') return defaultVal;
            return isNumber ? Number(value) : value;
        };
        
        const settings = {
            search_interval_seconds: Math.max(30, Math.min(300, normalizeValue(req.body.search_interval_seconds, 60))),
            premium_threshold_percent: Math.max(0.1, Math.min(5.0, normalizeValue(req.body.premium_threshold_percent, 1.0))),
            trading_intensity_threshold: Math.max(1, Math.min(10, normalizeValue(req.body.trading_intensity_threshold, 5))),
            min_trade_amount_krw: Math.max(100000, normalizeValue(req.body.min_trade_amount_krw, 1000000)),
            max_trade_amount_krw: Math.max(1000000, normalizeValue(req.body.max_trade_amount_krw, 10000000)),
            bot_enabled: req.body.bot_enabled === 'true' || req.body.bot_enabled === 'on' || req.body.bot_enabled === true
        };
        
        // 최대 거래 금액이 최소 거래 금액보다 작으면 자동 조정
        if (settings.max_trade_amount_krw < settings.min_trade_amount_krw) {
            settings.max_trade_amount_krw = settings.min_trade_amount_krw * 2;
        }
        
        await userBotService.updateBotSettings(settings);
        
        console.log(`사용자 ${req.user.username} 봇 설정 업데이트 완료:`, settings);
        req.flash('success', '봇 설정이 성공적으로 저장되었습니다.');
        res.redirect('/dashboard/settings');
    } catch (error) {
        console.error('봇 설정 업데이트 오류:', error);
        req.flash('error', '봇 설정 저장 중 오류가 발생했습니다.');
        res.redirect('/dashboard/settings');
    }
});

// 봇 시작/정지
router.post('/bot/:action', requireAuth, async (req, res) => {
    try {
        const action = req.params.action;
        const userBotService = new UserBotService(req.user.id);

        const newSettings = {
            bot_enabled: action === 'start'
        };

        await userBotService.updateBotSettings(newSettings);
        
        const message = action === 'start' ? 
            '개인 김프 봇이 시작되었습니다!' : 
            '개인 김프 봇이 중지되었습니다.';
            
        req.flash('success', message);
        res.redirect('/dashboard');
    } catch (error) {
        console.error('봇 제어 오류:', error);
        req.flash('error', '봇 제어 중 오류가 발생했습니다.');
        res.redirect('/dashboard');
    }
});

// API 키 관리 페이지
router.get('/api-keys', requireAuth, async (req, res) => {
    try {
        const apiKeyService = new ApiKeyService(req.user.id);
        const [apiKeys, exchanges] = await Promise.all([
            apiKeyService.getUserApiKeys(),
            getExchanges()
        ]);

        res.render('user/api-keys', {
            title: `${req.user.username}님의 API 키 관리`,
            user: req.user,
            apiKeys,
            exchanges,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('API 키 관리 페이지 오류:', error);
        req.flash('error', 'API 키 관리 페이지를 불러오는 중 오류가 발생했습니다.');
        res.redirect('/dashboard');
    }
});

// API 키 저장
router.post('/api-keys', requireAuth, async (req, res) => {
    try {
        const apiKeyService = new ApiKeyService(req.user.id);
        const { exchange_id, api_key, secret_key, passphrase } = req.body;
        
        // 입력값 검증
        if (!exchange_id || !api_key || !secret_key) {
            req.flash('error', '모든 필수 필드를 입력해주세요.');
            return res.redirect('/dashboard/api-keys');
        }
        
        await apiKeyService.saveApiKey(exchange_id, api_key.trim(), secret_key.trim(), passphrase?.trim());
        req.flash('success', 'API 키가 성공적으로 저장되었습니다. 연결 테스트를 진행해주세요.');
    } catch (error) {
        req.flash('error', `API 키 저장 실패: ${error.message}`);
    }
    res.redirect('/dashboard/api-keys');
});

// API 키 테스트
router.post('/api-keys/:id/test', requireAuth, async (req, res) => {
    try {
        const apiKeyService = new ApiKeyService(req.user.id);
        const result = await apiKeyService.testApiKey(req.params.id);
        
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
    res.redirect('/dashboard/api-keys');
});

// API 키 삭제
router.post('/api-keys/:id/delete', requireAuth, async (req, res) => {
    try {
        const apiKeyService = new ApiKeyService(req.user.id);
        await apiKeyService.deleteApiKey(req.params.id);
        req.flash('success', 'API 키가 삭제되었습니다.');
    } catch (error) {
        req.flash('error', `삭제 실패: ${error.message}`);
    }
    res.redirect('/dashboard/api-keys');
});

// 입금주소 관리 페이지
router.get('/deposit-addresses', requireAuth, async (req, res) => {
    try {
        const settingsService = new UserSettingsService(req.user.id);
        const [addresses, exchanges, coins] = await Promise.all([
            settingsService.getAllDepositAddresses(),
            getActiveExchanges(),
            getTradableCoins()
        ]);

        res.render('user/deposit-addresses', {
            title: `${req.user.username}님의 입금주소 관리`,
            user: req.user,
            addresses,
            exchanges,
            coins,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('입금주소 관리 페이지 오류:', error);
        req.flash('error', '입금주소 관리 페이지를 불러오는 중 오류가 발생했습니다.');
        res.redirect('/dashboard');
    }
});

// 입금주소 저장
router.post('/deposit-addresses', requireAuth, async (req, res) => {
    try {
        const { exchange_id, symbol, address, memo } = req.body;
        
        if (!exchange_id || !symbol || !address) {
            req.flash('error', '거래소, 코인, 주소는 필수입니다.');
            return res.redirect('/dashboard/deposit-addresses');
        }

        const settingsService = new UserSettingsService(req.user.id);
        await settingsService.upsertDepositAddress(
            Number(exchange_id), 
            symbol.trim(), 
            address.trim(), 
            memo?.trim() || ''
        );
        
        req.flash('success', '입금주소가 성공적으로 저장되었습니다.');
    } catch (error) {
        req.flash('error', `입금주소 저장 실패: ${error.message}`);
    }
    res.redirect('/dashboard/deposit-addresses');
});

// 입금주소 삭제
router.post('/deposit-addresses/:exchangeId/:symbol/delete', requireAuth, async (req, res) => {
    try {
        const { exchangeId, symbol } = req.params;
        const settingsService = new UserSettingsService(req.user.id);
        
        await settingsService.deleteDepositAddress(Number(exchangeId), symbol);
        req.flash('success', '입금주소가 삭제되었습니다.');
    } catch (error) {
        req.flash('error', `삭제 실패: ${error.message}`);
    }
    res.redirect('/dashboard/deposit-addresses');
});


// 수동 거래 테스트 페이지
router.get('/trade/manual', requireAuth, async (req, res) => {
    try {
        const connection = await db.getConnection();
        const [coins] = await connection.execute(`
            SELECT symbol, name FROM coins 
            WHERE is_active = TRUE AND is_tradable = TRUE 
            ORDER BY symbol
        `);
        connection.release();

        const userBotService = new UserBotService(req.user.id);
        const botSettings = await userBotService.getBotSettings();

        res.render('user/manual-trade', {
            title: `${req.user.username}님의 거래 테스트`,
            user: req.user,
            coins: coins,
            botSettings: botSettings,
            success: req.flash('success'),
            error: req.flash('error')
        });
    } catch (error) {
        console.error('수동 거래 페이지 오류:', error);
        req.flash('error', '페이지를 불러오는 중 오류가 발생했습니다.');
        res.redirect('/dashboard');
    }
});

// 수동 거래 실행
router.post('/trade/execute', requireAuth, async (req, res) => {
    try {
        const { symbol, budget, dryRun } = req.body;
        
        if (!symbol || !budget) {
            req.flash('error', '코인과 거래 금액을 입력해주세요.');
            return res.redirect('/dashboard/trade/manual');
        }

        const budgetAmount = parseFloat(budget);
        if (isNaN(budgetAmount) || budgetAmount <= 0) {
            req.flash('error', '올바른 거래 금액을 입력해주세요.');
            return res.redirect('/dashboard/trade/manual');
        }

        const tradeService = new TradeExecutionService();
        const result = await tradeService.executeOnce(
            req.user.id,ㄴ
            symbol.toUpperCase(),
            budgetAmount,
            dryRun === 'true'
        );

        if (result.success) {
            const mode = result.dryRun ? '시뮬레이션' : '실거래';
            const profit = result.netProfit >= 0 ? 
                `+${result.netProfit.toLocaleString()}원 (${result.profitRate.toFixed(4)}%)` :
                `${result.netProfit.toLocaleString()}원 (${result.profitRate.toFixed(4)}%)`;
            
            req.flash('success', 
                `${symbol} ${mode} 완료! ` +
                `거래 ID: ${result.tradeId}, 수익: ${profit}`
            );
        } else {
            req.flash('error', `거래 실패: ${result.error}`);
        }

    } catch (error) {
        console.error('거래 실행 오류:', error);
        req.flash('error', `거래 실행 중 오류가 발생했습니다: ${error.message}`);
    }

    res.redirect('/dashboard/trade/manual');
});


// 헬퍼 함수
async function getExchanges() {
    // const connection = await db.getConnection();
    // const [rows] = await connection.execute(`
    //     SELECT id, name, type FROM exchanges 
    //     WHERE name IN ('업비트', '바이낸스') AND is_active = TRUE 
    //     ORDER BY type, name
    // `);
    // connection.release();
    // return rows;
    const ExchangeManagementService = require('../services/ExchangeManagementService');
    return await ExchangeManagementService.getActiveExchanges();
}

async function getActiveExchanges() {
    const connection = await db.getConnection();
    const [rows] = await connection.execute(`
        SELECT id, name, type FROM exchanges 
        WHERE is_active = TRUE AND name IN ('업비트', '바이낸스') 
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


module.exports = router;