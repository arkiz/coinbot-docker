// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const db = require('../config/database');
const router = express.Router();

// Passport 로컬 전략 설정
passport.use(new LocalStrategy({
    usernameField: 'email',
    passwordField: 'password'
}, async (email, password, done) => {
    try {
        console.log(`로그인 시도: ${email}`);
        
        const connection = await db.getConnection();
        const [rows] = await connection.execute(
            'SELECT * FROM users WHERE email = ? AND is_active = TRUE',
            [email]
        );
        connection.release();

        if (rows.length === 0) {
            console.log(`사용자 없음: ${email}`);
            return done(null, false, { message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }

        const user = rows[0];
        
        // 비밀번호 확인
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            console.log(`비밀번호 불일치: ${email}`);
            return done(null, false, { message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }

        // 마지막 로그인 시간 업데이트
        const updateConnection = await db.getConnection();
        await updateConnection.execute(
            'UPDATE users SET last_login = NOW() WHERE id = ?',
            [user.id]
        );
        updateConnection.release();

        console.log(`로그인 성공: ${user.username} (${user.role})`);
        return done(null, user);

    } catch (error) {
        console.error('로그인 오류:', error);
        return done(error);
    }
}));

// 세션 직렬화/역직렬화
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const connection = await db.getConnection();
        const [rows] = await connection.execute(
            'SELECT id, username, email, role, is_active FROM users WHERE id = ?',
            [id]
        );
        connection.release();

        if (rows.length > 0) {
            done(null, rows[0]);
        } else {
            done(new Error('사용자를 찾을 수 없습니다.'), null);
        }
    } catch (error) {
        done(error, null);
    }
});

// 로그인 페이지
router.get('/login', (req, res) => {
    if (req.isAuthenticated()) {
        if (req.user.role === 'admin') {
            return res.redirect('/admin');
        } else {
            return res.redirect('/dashboard');
        }
    }

    res.render('auth/login', {
        title: '김프 봇 로그인',
        error: req.flash('error'),
        success: req.flash('success')
    });
});

// 로그인 처리
router.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            console.error('로그인 인증 오류:', err);
            req.flash('error', '로그인 처리 중 오류가 발생했습니다.');
            return res.redirect('/auth/login');
        }

        if (!user) {
            req.flash('error', info.message || '로그인에 실패했습니다.');
            return res.redirect('/auth/login');
        }

        req.logIn(user, (err) => {
            if (err) {
                console.error('세션 생성 오류:', err);
                req.flash('error', '세션 생성에 실패했습니다.');
                return res.redirect('/auth/login');
            }

            // 역할에 따른 리다이렉트
            if (user.role === 'admin') {
                req.flash('success', `관리자 ${user.username}님 환영합니다!`);
                return res.redirect('/admin');
            } else {
                req.flash('success', `${user.username}님 환영합니다!`);
                return res.redirect('/dashboard');
            }
        });
    })(req, res, next);
});

// 로그아웃
router.post('/logout', (req, res) => {
    const username = req.user ? req.user.username : '사용자';
    
    req.logout((err) => {
        if (err) {
            console.error('로그아웃 오류:', err);
        } else {
            console.log(`로그아웃: ${username}`);
        }
        
        req.session.destroy(() => {
            res.redirect('/auth/login');
        });
    });
});

// 임시 사용자 생성 API (개발용 - 나중에 제거)
router.get('/create-test-users', async (req, res) => {
    try {
        const bcrypt = require('bcrypt');
        
        // 기존 테스트 계정 삭제
        const connection = await db.getConnection();
        await connection.execute("DELETE FROM users WHERE email IN ('admin@coinbot.com', 'user@coinbot.com')");
        
        // 새로운 해시 생성
        const adminHash = await bcrypt.hash('admin123', 10);
        const userHash = await bcrypt.hash('user123', 10);
        
        console.log('🔐 생성된 해시값:');
        console.log('Admin Hash:', adminHash);
        console.log('User Hash:', userHash);
        
        // 사용자 생성
        await connection.execute(
            'INSERT INTO users (username, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, TRUE, NOW())',
            ['admin', 'admin@coinbot.com', adminHash, 'admin']
        );
        
        await connection.execute(
            'INSERT INTO users (username, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, TRUE, NOW())',
            ['testuser', 'user@coinbot.com', userHash, 'user']
        );
        
        connection.release();
        
        res.json({
            success: true,
            message: '✅ 테스트 사용자가 성공적으로 생성되었습니다!',
            accounts: [
                { email: 'admin@coinbot.com', password: 'admin123', role: 'admin' },
                { email: 'user@coinbot.com', password: 'user123', role: 'user' }
            ],
            note: '이제 위 계정 정보로 로그인하세요.'
        });
        
    } catch (error) {
        console.error('❌ 사용자 생성 오류:', error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

module.exports = router;
