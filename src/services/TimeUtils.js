class TimeUtils {
    constructor() {
        // 한국 표준시 (KST) UTC+9
        this.KST_OFFSET = 9 * 60 * 60 * 1000; // 9시간을 밀리초로
    }

    // UTC 시간을 KST로 변환
    utcToKst(utcDate) {
        if (!utcDate) return null;
        
        const date = new Date(utcDate);
        const kstTimestamp = date.getTime() + this.KST_OFFSET;
        const kstDate = new Date(kstTimestamp);
        
        return {
            utc: date.toISOString(),
            kst: kstDate.toISOString().replace('Z', '+09:00'),
            kstDisplay: kstDate.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19),
            kstShort: kstDate.toISOString().slice(5, 16).replace('T', ' ')
        };
    }

    // 현재 시간을 UTC와 KST로 반환
    now() {
        return this.utcToKst(new Date());
    }

    // 김프 거래에 특화된 시간 정보
    getTradingTimeInfo() {
        const timeInfo = this.now();
        const kstDate = new Date(timeInfo.kst);
        const hour = kstDate.getHours();
        
        return {
            ...timeInfo,
            hour,
            isKoreanTradingHours: hour >= 9 && hour < 18, // 한국 주식시장 시간
            isCryptoActiveHours: hour >= 8 && hour < 24,   // 암호화폐 활발한 시간대
            marketStatus: this.getMarketStatus(hour)
        };
    }

    // 시장 상태 판단 (한국 기준)
    getMarketStatus(hour) {
        if (hour >= 0 && hour < 6) return 'overnight';      // 새벽
        if (hour >= 6 && hour < 9) return 'pre_market';     // 장 시작 전
        if (hour >= 9 && hour < 15) return 'main_trading';  // 주 거래시간
        if (hour >= 15 && hour < 18) return 'post_market';  // 장 마감 후
        if (hour >= 18 && hour < 24) return 'evening';      // 저녁
        return 'unknown';
    }

    // 시간 차이 계산 (한국어)
    getTimeAgo(pastDate) {
        if (!pastDate) return null;
        
        const now = new Date();
        const past = new Date(pastDate);
        const diffMs = now - past;
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMinutes / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMinutes < 1) return '방금 전';
        if (diffMinutes < 60) return `${diffMinutes}분 전`;
        if (diffHours < 24) return `${diffHours}시간 전`;
        if (diffDays < 7) return `${diffDays}일 전`;
        
        return this.utcToKst(pastDate).kstDisplay;
    }

    // 거래 로그용 타임스탬프 (한국 시간)
    getLogTimestamp() {
        const timeInfo = this.now();
        return `[${timeInfo.kstDisplay}]`;
    }
}

module.exports = TimeUtils;
