// routes/dashboard.js
const express = require('express');
const UserBotService = require('../services/UserBotService');
const db = require('../config/database');
const router = express.Router();

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
            title: `${req.user.username}님의 김프 봇 대시1보드`,
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

module.exports = router;