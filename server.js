const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// =================== High-Quality Neural TTS API (Microsoft Azure SunHi) ===================
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// 반복 안내 음성 메모리 캐시 (0ms 초고속 반응)
const ttsCache = new Map();

app.get('/api/tts', async (req, res) => {
    try {
        const text = (req.query.text || '').trim();
        if (!text) return res.status(400).send('No text provided');

        const clean = text
            .replace(/\[LG Well\]/gi, '')
            .replace(/[\[\]#*`\n]/g, ' ')
            .trim();

        if (!clean) return res.status(400).send('Empty text');

        // 기본 음성: ko-KR-InJoonNeural (전문 스포츠 아나운서 스타일)
        // 기본 속도: +20% (경쾌하고 빠른 전달력)
        const voice = req.query.voice || 'ko-KR-InJoonNeural';
        let rate = (req.query.rate || '+20%').trim();
        if (!rate.startsWith('+') && !rate.startsWith('-')) rate = '+' + rate;
        let pitch = (req.query.pitch || '+0Hz').trim();
        if (!pitch.startsWith('+') && !pitch.startsWith('-')) pitch = '+' + pitch;

        const cacheKey = `${voice}_${rate}_${pitch}_${clean}`;
        if (ttsCache.has(cacheKey)) {
            const cachedBuf = ttsCache.get(cacheKey);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.end(cachedBuf);
        }

        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        const { audioStream } = tts.toStream(clean, { rate, pitch });
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        const chunks = [];
        audioStream.on('data', chunk => chunks.push(chunk));
        audioStream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (ttsCache.size < 300) {
                ttsCache.set(cacheKey, buf);
            }
        });

        audioStream.pipe(res);
        audioStream.on('error', (err) => {
            console.error('TTS stream pipe error:', err.message);
            if (!res.headersSent) res.status(500).send('TTS error');
        });
    } catch (e) {
        console.error('TTS endpoint error:', e.message);
        if (!res.headersSent) res.status(500).send('TTS error');
    }
});

// 전체 운동 일지 및 세트 기록 반환 API
app.get('/api/history', (req, res) => {
    try {
        delete require.cache[require.resolve('./workoutHistoryData')];
        const fresh = require('./workoutHistoryData');
        if (fresh && typeof fresh.generateWorkoutHistory === 'function') {
            setHistory = fresh.generateWorkoutHistory();
        } else if (fresh && fresh.initialSetHistory) {
            setHistory = fresh.initialSetHistory;
        }
    } catch (e) {
        console.error('Failed to reload workoutHistoryData:', e);
    }
    res.json({ success: true, count: setHistory.length, setHistory });
});

// Set your Arduino COM port here
const ARDUINO_PORT = 'COM3';
const BAUD_RATE = 9600;

let port;
let sensorDataBuffer = [];
let recentDataBuffer = [];
let currentStatus = 'WAITING';
let isAnalyzing = false;
let lastValue = 0;
let hasUserInteracted = false; // 최초 운동 개시 감지 플래그
let isDangerActive = false;    // 위험 감지 및 안전 리프트 상태 플래그 (절대 자동 전환되지 않고 대화로 해제)
let awaitingDangerEscapeConfirm = false; // 바텀 탈진 위험 후 사용자 안부 및 탈출 확인 대기
let isBodyDetached = false;    // 1번 버튼 (11번 핀): 바 신체 이탈 감지 및 바 위치 즉시 고정
let lockedBarValue = null;     // 바 위치 고정 센서값 (null: 정상 추적, 숫자: 해당 값으로 화면/제어 고정)
let isImbalanceActive = false; // 2번 버튼 (12번 핀): 좌우 힘 불균형 감지 플래그
let isWeightLocked = false;    // 불균형 교정 중 무게 증량 잠금 플래그
let awaitingMainWorkoutConfirm = false; // 불균형 교정 후 본 운동 시작 확인 대기
let preImbalanceWeightKg = null; // 불균형 감지 직전 원래 본 운동 무게 보관 (동의 후 복원용)
let dangerCooldownUntil = 0;   // 위험 해제 직후 재트리거 방지 쿨다운 만료 시각 (ms)
let assistLevel = 0; // 부하 감소 단계 (0: 정상, 1: 1차 감소, 2: 2차 감소...)
let lastAssistTimestamp = 0; // 마지막 부하 감소 적용 시각 (쿨다운용)
let currentRepAssistCount = 0; // 현재 1회 반복(Rep) 도중 부하 감경 발동 횟수 (동일 랩 중복 출력 원천 차단)
let bottomMoveStartTime = 0; // 바텀 범위 내에서 꼼질꼼질 움직인 시작 시각 (2.5초 후 DANGER)
let lastBottomMoveTimestamp = 0; // 바텀 범위 내 마지막 움직임 감지 시각 (순간 멈칫 보정용)
let bottomStillStartTime = 0; // 바텀 범위 내에서 완전히 정지한 시작 시각 (3.5초 후 REST/세트완료)
let midStallStartTime = 0;    // 바텀-탑 중간 구간 정체 시작 시각 (1.4초 후 ASSIST)

// =================== AI 에이전트 동적 제어 변수 ===================
let aiTargetReps = 10;
let aiTargetSets = 5;
let aiRestTimeSeconds = 60;
let isUserCustomRestTime = false; // 사용자가 명시적으로 설정한 휴식 시간 보호 플래그

// =================== 운동량 및 VBT 분석 트래킹 상태 ===================
let currentSet = 1;
let currentSetReps = 0;
let totalReps = 0;
let repStage = 'WAITING_START'; // 'WAITING_START' | 'GOING_UP' | 'AT_TOP' | 'GOING_DOWN'
let repStartTime = 0;
let peakValue = 0;
let lastRepDuration = 0;
let recentTempos = []; // 최근 세트 템포 기록 (초)

function getFormattedDate(d = new Date()) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

let userWeightKg = 0.0; // 운동 시작 전 초기 상태: 0.0kg
let currentSetStartTime = 0;
let currentSetStartWeightKg = 0.0;
let currentSetStartLevel = 0;
let currentSetLoadChanges = []; // 세트 내 강도 변화 이력 [{ time, fromKg, toKg, fromPercent, toPercent, reason }]
let currentSetTempos = []; // 세트 내 각 반복별 템포
let currentSetRoms = []; // 세트 내 각 반복별 ROM
let currentSetPeaks = []; // 세트 내 각 반복별 센서 최고치
let currentSetAssistTriggers = 0;
let currentSetDangerTriggers = 0;
let lastSetRestDurationSec = 0; // 직전 세트 종료 후 이번 세트 시작까지의 실제 휴식 시간
let latestCoachFeedback = ''; // 최신 AI 코치 코멘트

function getCurrentLoadKg(weightKg = userWeightKg, level = assistLevel) {
    if (typeof weightKg === 'number' && !isNaN(weightKg)) return weightKg;
    return typeof userWeightKg === 'number' ? userWeightKg : 0.0;
}

function createDetailedSetRecord(data) {
    const reps = data.reps || 10;
    const targetReps = data.targetReps || 10;
    const baseWeightKg = data.baseWeightKg || 70.0;
    const assistLvl = typeof data.assistLevel !== 'undefined' ? data.assistLevel : 0;
    const startIntensityPct = data.startIntensityPercent || 100;
    const finalIntensityPct = data.finalIntensityPercent || Math.round(Math.max(0.2, 1 - assistLvl * 0.15) * 100);
    const startLoadKg = data.startLoadKg || Math.round(baseWeightKg * (startIntensityPct / 100) * 10) / 10;
    const finalLoadKg = data.finalLoadKg || Math.round(baseWeightKg * (finalIntensityPct / 100) * 10) / 10;
    const tempos = (data.repTempos && data.repTempos.length > 0) ? data.repTempos : Array.from({ length: reps }, (_, i) => Number((2.0 + i * 0.08).toFixed(1)));
    const avgTempo = Number((tempos.reduce((a, b) => a + b, 0) / tempos.length).toFixed(1));
    const fastestTempo = Math.min(...tempos);
    const slowestTempo = Math.max(...tempos);
    const fastestRepIndex = tempos.indexOf(fastestTempo) + 1;
    const slowestRepIndex = tempos.indexOf(slowestTempo) + 1;
    const dropRate = tempos.length >= 2 ? Math.round(((tempos[tempos.length - 1] - tempos[0]) / tempos[0]) * 100) : 0;
    const roms = (data.repRoms && data.repRoms.length > 0) ? data.repRoms : Array.from({ length: reps }, (_, i) => i === 0 || i === 1 ? 'PERFECT' : (i === reps - 1 && dropRate > 20 ? 'PARTIAL' : 'GOOD'));
    const perfectCount = roms.filter(r => r === 'PERFECT').length;
    const totalVolume = Math.round(reps * finalLoadKg * 10) / 10;

    // 1. 템포 변곡점 (Tempo Inflection Point) & 속도 저하(Velocity Loss) 분석
    let tempoInflectionRep = null;
    let maxTempoJumpPercent = 0;
    for (let i = 1; i < tempos.length; i++) {
        const jump = Math.round(((tempos[i] - tempos[i - 1]) / tempos[i - 1]) * 100);
        if (jump >= 18 && jump > maxTempoJumpPercent) {
            maxTempoJumpPercent = jump;
            tempoInflectionRep = i + 1;
        }
    }
    const earlyAvg = tempos.slice(0, Math.max(1, Math.min(3, Math.floor(tempos.length / 2)))).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(3, Math.floor(tempos.length / 2)));
    const lateAvg = tempos.slice(-Math.max(1, Math.min(3, Math.floor(tempos.length / 2)))).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(3, Math.floor(tempos.length / 2)));
    const velocityLossPercent = Math.max(0, Math.round(((lateAvg - earlyAvg) / earlyAvg) * 100));

    const tempoPatternType = velocityLossPercent > 35
        ? '후반 급격 탈진형 (Fatigue Crash)'
        : (velocityLossPercent > 15 ? '점진적 피로 누적형 (Gradual Fatigue)' : '균일 파워 유지형 (Consistent Power)');

    const tempoInflectionSummary = tempoInflectionRep
        ? `R${tempoInflectionRep}회차에서 템포 +${maxTempoJumpPercent}% 급증 (피로 임계점 도달)`
        : (dropRate > 15 ? `특정 변곡점 없이 서서히 감속 (전반 대비 ${velocityLossPercent}% 속도 저하)` : `전 반복 구간 균일 페이스 유지 (변곡점 없음)`);

    // 2. 휴식 사이클 및 회복 지표 (Rest Cycle & Recovery Analysis)
    const setNum = data.set || 1;
    const actualRestSec = typeof data.restBeforeSetSeconds === 'number' ? data.restBeforeSetSeconds : (setNum > 1 ? 58 : 0);
    const recRestSec = data.recommendedRestSeconds || 60;
    let restQuality = '첫 세트 (휴식 주기 해당 없음)';
    let restRecoveryScore = 100;
    let restDifferenceSec = 0;

    if (setNum > 1) {
        restDifferenceSec = actualRestSec - recRestSec;
        const restRatio = Math.round((actualRestSec / recRestSec) * 100);
        if (restRatio < 75) {
            restQuality = `회복 부족 (권장 대비 ${Math.abs(restDifferenceSec)}초 조기 시작 -> 후반 세트 피로 급증 요인)`;
            restRecoveryScore = Math.max(50, Math.round(restRatio));
        } else if (restRatio <= 125) {
            restQuality = `최적 회복 사이클 (권장 ${recRestSec}초 기준 ${actualRestSec}초 준수, ATP-PCr 85% 이상 재합성)`;
            restRecoveryScore = Math.min(100, 100 - Math.abs(restDifferenceSec));
        } else {
            restQuality = `충분한 지연 회복 (권장 대비 +${restDifferenceSec}초 추가 회복으로 근신경 피로 해소)`;
            restRecoveryScore = Math.max(70, 100 - Math.round(restDifferenceSec * 0.5));
        }
    }

    // 3. 부하 감경 이력 (Load Reduction Context History)
    const rawHistory = data.loadChangeHistory || (assistLvl > 0 ? [{
        time: data.completedAt || '12:00:00',
        set: setNum,
        repAtTrigger: Math.max(1, reps),
        totalRepsAtTrigger: reps,
        heightPct: 52,
        fromKg: startLoadKg,
        toKg: finalLoadKg,
        reductionKg: Math.round((startLoadKg - finalLoadKg) * 10) / 10,
        fromPercent: startIntensityPct,
        toPercent: finalIntensityPct,
        reductionPercent: startIntensityPct - finalIntensityPct,
        reason: '중간 정체 7초 감지 (-15% 부하 감소 적용)',
        triggerType: 'mid_stall_7s'
    }] : []);

    const enrichedLoadChanges = rawHistory.map(item => ({
        time: item.time || data.completedAt || '12:00:00',
        set: item.set || setNum,
        repAtTrigger: item.repAtTrigger || (item.rep ? parseInt(item.rep, 10) : reps),
        totalRepsAtTrigger: item.totalRepsAtTrigger || reps,
        heightPct: item.heightPct || 52,
        fromKg: item.fromKg,
        toKg: item.toKg,
        reductionKg: Math.max(0, Math.round(((item.fromKg || startLoadKg) - (item.toKg || finalLoadKg)) * 10) / 10),
        fromPercent: item.fromPercent || startIntensityPct,
        toPercent: item.toPercent || finalIntensityPct,
        reductionPercent: Math.max(0, (item.fromPercent || startIntensityPct) - (item.toPercent || finalIntensityPct)),
        reason: item.reason || '무게 부담 감지 자동 감경',
        triggerType: item.triggerType || (item.reason && item.reason.includes('3초') ? 'stall_3s_continuous' : 'mid_stall_7s')
    }));

    // 4. 종합 운동 패턴 진단 (Comprehensive Workout Pattern Insight)
    let patternKeyFinding = '';
    if (enrichedLoadChanges.length > 0) {
        const firstEv = enrichedLoadChanges[0];
        patternKeyFinding = `Set ${setNum} ${firstEv.repAtTrigger}회차 시도 중(${firstEv.reductionKg}kg 감경) 부하 한계 도달 및 스마트 보조 가동`;
    } else if (velocityLossPercent > 25) {
        patternKeyFinding = `감경 없이 완주했으나 R${tempoInflectionRep || fastestRepIndex} 이후 템포 ${velocityLossPercent}% 저하되며 후반 저항 발생`;
    } else {
        patternKeyFinding = `부하 감경 없이 균일한 속도(템포 저하율 ${velocityLossPercent}%)로 전 구간 파워 완벽 유지`;
    }

    return {
        setId: data.setId || `set_${data.date || '2026-10-06'}_${setNum}`,
        date: data.date,
        set: setNum,
        startTime: data.startTime || '12:00:00',
        completedAt: data.completedAt,
        durationSeconds: data.durationSeconds || Math.round(reps * avgTempo + 4),

        reps: reps,
        targetReps: targetReps,
        targetAchievementRate: Math.round((reps / targetReps) * 100),

        baseWeightKg: baseWeightKg,
        startLoadKg: startLoadKg,
        startIntensityPercent: startIntensityPct,
        finalLoadKg: finalLoadKg,
        finalIntensityPercent: finalIntensityPct,
        assistLevel: assistLvl,
        totalVolumeKg: totalVolume,

        // 패턴 1: 부하 감경 & 정체 발생 지점
        loadReductionContext: {
            isAssisted: assistLvl > 0,
            assistTriggersCount: enrichedLoadChanges.length,
            totalReductionKg: Math.max(0, Math.round((startLoadKg - finalLoadKg) * 10) / 10),
            totalReductionPercent: Math.max(0, startIntensityPct - finalIntensityPct),
            firstReductionPoint: enrichedLoadChanges.length > 0
                ? `Set ${setNum} · ${enrichedLoadChanges[0].repAtTrigger}회차 수행 중 (높이 ${enrichedLoadChanges[0].heightPct}%)`
                : '부하 감경 없음 (100% 자력 수행)',
            events: enrichedLoadChanges
        },
        loadChangeHistory: enrichedLoadChanges,
        assistCount: data.assistCount || enrichedLoadChanges.length,
        dangerCount: data.dangerCount || 0,

        // 패턴 2: 템포 변곡점 & 피로 임계 지점
        tempoPatterns: {
            tempos: tempos,
            avgTempo: avgTempo,
            fastestRep: { rep: fastestRepIndex, tempo: fastestTempo },
            slowestRep: { rep: slowestRepIndex, tempo: slowestTempo },
            inflectionPoint: {
                rep: tempoInflectionRep,
                jumpPercent: maxTempoJumpPercent,
                summary: tempoInflectionSummary
            },
            velocityLossPercent: velocityLossPercent,
            patternType: tempoPatternType
        },
        repTempos: tempos,
        avgTempo: avgTempo,
        fastestTempo: fastestTempo,
        slowestTempo: slowestTempo,
        tempoDropRatePercent: velocityLossPercent,
        repRoms: roms,
        perfectRomRatioPercent: Math.round((perfectCount / reps) * 100),

        // 패턴 3: 휴식 사이클 & 회복 지표
        restCyclePattern: {
            set: setNum,
            actualRestSeconds: actualRestSec,
            recommendedRestSeconds: recRestSec,
            restDifferenceSeconds: restDifferenceSec,
            recoveryQuality: restQuality,
            recoveryScore: restRecoveryScore,
            summary: setNum === 1 ? '첫 세트 시작' : `${actualRestSec}초 휴식 (권장 ${recRestSec}초 대비 ${restDifferenceSec >= 0 ? '+' : ''}${restDifferenceSec}초)`
        },
        restBeforeSetSeconds: actualRestSec,
        recommendedRestSeconds: recRestSec,
        restCompliance: restQuality,

        // 패턴 4: 종합 바이오메트릭스 패턴 진단 및 Agent 처방
        workoutPatternSummary: {
            keyFinding: patternKeyFinding,
            fatigueThresholdPoint: tempoInflectionSummary,
            recoveryConsistency: restQuality,
            overallRhythmGrade: velocityLossPercent < 20 && perfectCount >= reps * 0.7 ? 'A+ (최상급 VBT 안정성)' : (velocityLossPercent < 35 ? 'B+ (안정적 볼륨 소화)' : 'B- (후반 피로 집중 관리 필요)')
        },

        agentInsights: data.agentInsights || {
            fatigueIndex: velocityLossPercent > 25 ? '주의 (후반 급격한 템포 저하)' : '안정적 (페이스 유지)',
            formConsistency: perfectCount >= 2 ? '우수 (가동범위 양호)' : '보통',
            coachFeedbackSnippet: data.coachFeedbackSnippet || patternKeyFinding,
            futureAgentOpportunity: enrichedLoadChanges.length > 0
                ? `부하 감경(${enrichedLoadChanges[0].reductionKg}kg) 지점을 분석하여 다음 세트는 시작부터 ${finalLoadKg}kg로 세팅 시 유효 반복 10회 달성 확률 87%`
                : (velocityLossPercent > 25
                    ? `템포 변곡점(R${tempoInflectionRep || 4}) 이후 피로 누적 -> 휴식 시간을 +15초 연장하여 ATP-PCr 완전 충전 권장`
                    : `높은 속도 일관성 유지 -> 다음 세트 동일 부하 유지 또는 목표 1회 증량 도전 추천`)
        }
    };
}

// 2026년 9월 1일부터 10월 7일(어제)까지의 일지 데이터 로드
const { initialSetHistory } = require('./workoutHistoryData');
let setHistory = initialSetHistory;

let isResting = false;
let restStartTime = 0;

const THRESHOLD_BOTTOM = 280; // 하단 기준 (시작/완료)
const THRESHOLD_TOP = 740;    // 상단 최고점 기준

// =================== 실시간 안전 및 모션 타이밍 임계치 (단위: ms) ===================
let DANGER_TRIGGER_MS = 2500;      // 바텀 탈진 꼼질거림 위험 감지 시간: 2.5초 (신속 감지)
let MID_STALL_TRIGGER_MS = 3000;   // 바텀-탑 중간 정체 감지 시간: 3.0초 (3초 정체 시 5kg 감소)
let CONT_STALL_TRIGGER_MS = 5000;  // 정체 지속 시 추가 감경 간격: 5.0초 (5초마다 5kg 연속 감소)
let SET_COMPLETE_STILL_MS = 3500;  // 세트 완료 완전 정지 판정 시간: 3.5초

function getWorkoutStatePayload() {
    const avgTempo = recentTempos.length > 0
        ? recentTempos.reduce((a, b) => a + b, 0) / recentTempos.length
        : lastRepDuration;
    const restSec = isResting ? Math.floor((Date.now() - restStartTime) / 1000) : 0;
    const remainingRest = isResting ? Math.max(0, aiRestTimeSeconds - restSec) : 0;

    const loadKg = getCurrentLoadKg();
    const loadPercent = Math.round(Math.max(0.2, 1 - assistLevel * 0.15) * 100);

    return {
        currentSet,
        currentSetReps,
        totalReps,
        lastRepDuration: Number(lastRepDuration.toFixed(1)),
        avgTempo: Number((avgTempo || 0).toFixed(1)),
        isResting,
        isDangerActive,
        isBodyDetached,
        lockedBarValue,
        isImbalanceActive,
        isWeightLocked,
        awaitingMainWorkoutConfirm,
        awaitingDangerEscapeConfirm,
        restSeconds: restSec,
        remainingRestSeconds: remainingRest,
        setHistory,
        aiTargetReps,
        aiTargetSets,
        aiRestTimeSeconds,
        assistLevel,
        userWeightKg,
        currentLoadKg: loadKg,
        currentLoadPercent: loadPercent,
        isArduinoConnected: Boolean(port && port.isOpen),
        arduinoPort: typeof activePortPath !== 'undefined' ? activePortPath : ARDUINO_PORT
    };
}

// ⚡ 지침/정체/피로 발생 시 실시간 스마트 무게 부하 감경(다단계 ASSIST) 통합 함수
function applyAssistWeightReduction(reason = '중간 정체 감지', triggerType = 'mid_stall', sensorVal = lastValue) {
    // 이미 최저 한계(10kg)에 도달했으면 반복 감량 및 불필요한 출력 전면 차단
    if (userWeightKg <= 10.0) {
        return;
    }

    const now = Date.now();
    const prevKg = userWeightKg;
    // 1회당 5kg씩 직접 감소 (최저 10kg)
    userWeightKg = Math.max(10, Math.round((userWeightKg - 5.0) * 10) / 10);
    const nextKg = userWeightKg;
    assistLevel++;
    currentSetAssistTriggers++;
    currentRepAssistCount++;
    lastAssistTimestamp = now;
    currentStatus = 'ASSIST';

    const hPct = Math.round((sensorVal / 1023) * 100);
    const baseRef = currentSetStartWeightKg > 0 ? currentSetStartWeightKg : prevKg;
    currentSetLoadChanges.push({
        time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        set: currentSet,
        repAtTrigger: currentSetReps + 1,
        totalRepsAtTrigger: totalReps + 1,
        heightPct: hPct,
        fromKg: prevKg,
        toKg: nextKg,
        reductionKg: Math.round((prevKg - nextKg) * 10) / 10,
        fromPercent: Math.round((prevKg / baseRef) * 100),
        toPercent: Math.round((nextKg / baseRef) * 100),
        reductionPercent: Math.round(((prevKg - nextKg) / baseRef) * 100),
        reason: `${reason} (무게 5kg 직접 감소)`,
        triggerType: triggerType
    });

    console.log(`\n[스마트 부하 감경] ${reason} -> 무게 5kg 감소: ${prevKg}kg -> ${nextKg}kg (누적 Lv.${assistLevel})`);
    if (port && port.isOpen) {
        port.write('L\n');
    }
    const stallDecision = `정체 감지.\n무게 5kg 감소합니다.`;
    const stallSpeech = `정체 감지. 무게 5kg 감소합니다.`;
    io.emit('sensorData', {
        value: sensorVal,
        status: 'ASSIST',
        assistLevel: assistLevel,
        loadKg: nextKg,
        userWeightKg: nextKg,
        decision: stallDecision
    });
    io.emit('agentSpeech', { text: stallSpeech });
    io.emit('workoutState', getWorkoutStatePayload());
}

// =================== 시나리오 1: 신체 이탈 감지 및 바 위치 고정 (1번 버튼 / 11번 핀) ===================
function toggleBodyDetachment(source = 'hardware') {
    isBodyDetached = !isBodyDetached;

    if (isBodyDetached) {
        // 바에서 손/신체 떨어짐 -> 즉시 현재 위치에 바 고정!
        lockedBarValue = lastValue;
        currentStatus = 'BODY_DETACHED';
        if (port && port.isOpen) port.write('H\n'); // 위험/고정 신호 (적색 LED + 부저)

        const alertDecision = "신체 이탈 감지: 바 위치를 고정했습니다.";
        const speechText = "신체 이탈 감지, 바를 고정했습니다.";

        console.log(`\n[시나리오 1] 바 신체 이탈 감지 (${source}) -> 바 위치 즉시 고정 (${lockedBarValue})`);
        io.emit('sensorData', {
            value: lockedBarValue,
            status: 'BODY_DETACHED',
            isBodyDetached: true,
            lockedBarValue: lockedBarValue,
            decision: alertDecision
        });
        io.emit('agentSpeech', { text: speechText });
        io.emit('workoutState', getWorkoutStatePayload());
    } else {
        // 1번 버튼 다시 누름 -> 고정 해제 및 정상 복귀!
        lockedBarValue = null;
        currentStatus = 'NORMAL';
        if (port && port.isOpen) port.write('N\n'); // 정상 복귀 (녹색 LED)

        const clearDecision = "신체 접촉 확인: 바 고정을 해제했습니다.";
        const speechText = "바 고정을 해제합니다.";

        console.log(`\n[시나리오 1] 바 신체 접촉 재개 (${source}) -> 바 고정 해제 및 NORMAL 복귀`);
        io.emit('sensorData', {
            value: lastValue,
            status: 'NORMAL',
            isBodyDetached: false,
            lockedBarValue: null,
            decision: clearDecision
        });
        io.emit('agentSpeech', { text: speechText });
        io.emit('workoutState', getWorkoutStatePayload());
    }
}

// =================== 시나리오 2: 좌우 힘 불균형 감지 및 교정 시나리오 (2번 버튼 / 12번 핀) ===================
function toggleImbalanceScenario(source = 'hardware') {
    isImbalanceActive = !isImbalanceActive;

    if (isImbalanceActive) {
        // 2번 버튼 1회차: 좌우 불균형 감지 -> 무게를 딱 20kg으로 맞춤 + 무게 증량 잠금!
        isWeightLocked = true;
        awaitingMainWorkoutConfirm = false;
        if (preImbalanceWeightKg === null) {
            preImbalanceWeightKg = userWeightKg; // 원래 설정 무게 보관
        }
        const prevKg = userWeightKg;
        userWeightKg = 20.0;
        currentStatus = 'IMBALANCE';
        if (port && port.isOpen) port.write('L\n'); // 보조/불균형 신호 (청색 LED)

        const alertDecision = `좌우 불균형 감지: 부상 방지를 위해 20kg으로 조정했습니다.`;
        const speechText = "불균형 감지, 20kg으로 조정했습니다.";

        console.log(`\n[시나리오 2] 좌우 불균형 감지 (${source}) -> 무게 딱 20kg으로 설정 (${prevKg}kg -> 20.0kg) & 증량 잠금 활성화`);
        io.emit('sensorData', {
            value: lastValue,
            status: 'IMBALANCE',
            isImbalanceActive: true,
            isWeightLocked: true,
            userWeightKg: userWeightKg,
            decision: alertDecision
        });
        io.emit('agentSpeech', { text: speechText });
        io.emit('workoutState', getWorkoutStatePayload());
    } else {
        // 2번 버튼 2회차: 균형 교정 완료 안내 -> 단, 사용자가 동의하기 전까지는 불균형 때 사용한 교정 무게(20kg)와 잠금을 그대로 적용 유지!
        awaitingMainWorkoutConfirm = true;
        currentStatus = 'NORMAL';
        if (port && port.isOpen) port.write('N\n');

        const originalKg = preImbalanceWeightKg || 70.0;
        const questionDecision = `자세 교정 완료! 본 운동을 시작하시겠습니까?`;
        const speechText = "자세가 교정되었습니다. 본 운동을 시작하시겠습니까?";

        console.log(`\n[시나리오 2] 균형 교정 완료 (${source}) -> 동의 전까지 교정 무게(20kg) 유지한 채 본 운동 확인 대기`);
        io.emit('sensorData', {
            value: lastValue,
            status: 'NORMAL',
            isImbalanceActive: false,
            isWeightLocked: true, // 사용자가 확인하기 전까지는 잠금 및 교정 무게(20kg) 유지
            userWeightKg: userWeightKg, // 20kg 유지
            awaitingMainWorkoutConfirm: true,
            decision: questionDecision
        });
        io.emit('agentSpeech', { text: speechText });
        io.emit('workoutState', getWorkoutStatePayload());
    }
}

// 2번 시나리오 본 운동 돌입 승인
function confirmMainWorkout() {
    if (!awaitingMainWorkoutConfirm && !isWeightLocked) return;

    awaitingMainWorkoutConfirm = false;
    isWeightLocked = false; // 무게 증량 잠금 해제!
    currentStatus = 'NORMAL';
    if (port && port.isOpen) port.write('N\n');

    // 사용자가 동의했으므로 원래 본 운동 무게로 복구!
    const restoredKg = preImbalanceWeightKg !== null ? preImbalanceWeightKg : userWeightKg;
    userWeightKg = restoredKg;
    preImbalanceWeightKg = null; // 초기화

    const confirmDecision = `본 운동 재개 (${userWeightKg}kg 복원)`;
    const speechText = "원래 무게로 본 운동을 시작합니다.";

    console.log(`\n[시나리오 2] 본 운동 재돌입 승인 -> 원래 무게(${userWeightKg}kg) 복원 & 무게 잠금 해제 & 본 운동 복귀`);
    io.emit('sensorData', {
        value: lastValue,
        status: 'NORMAL',
        isImbalanceActive: false,
        isWeightLocked: false,
        userWeightKg: userWeightKg,
        awaitingMainWorkoutConfirm: false,
        decision: confirmDecision
    });
    io.emit('agentSpeech', { text: speechText });
    io.emit('workoutState', getWorkoutStatePayload());
}

// =================== 시나리오 3: 바텀 탈진(DANGER) 트리거 & 대화형 안전 해제 ===================
function triggerDangerScenario(source = 'system', reason = '바텀 탈진 위험 감지') {
    currentStatus = 'DANGER';
    isDangerActive = true;
    lockedBarValue = THRESHOLD_BOTTOM; // 바텀 안전선(280)에 바 위치 즉시 고정!
    awaitingDangerEscapeConfirm = true; // 에이전트의 사용자 안부 및 탈출 확인 대기
    assistLevel = 0;
    lastAssistTimestamp = 0;
    if (isResting) isResting = false;

    console.log(`\n[위험 상황 즉각 발동] (${source}: ${reason}) -> 바 위치 280 안전선 고정 및 안부 확인 대기`);
    if (port && port.isOpen) {
        port.write('H\n'); // 위험/고정 신호 (적색 LED + 부저)
    }

    const dangerDecision = `탈진 위험 감지! 바 고정 완료. 괜찮으신가요?`;
    const dangerSpeech = "탈진 위험 감지, 바를 고정했습니다. 괜찮으신가요?";

    io.emit('sensorData', {
        value: THRESHOLD_BOTTOM,
        status: 'DANGER',
        isDangerActive: true,
        lockedBarValue: THRESHOLD_BOTTOM,
        awaitingDangerEscapeConfirm: true,
        decision: dangerDecision
    });
    io.emit('agentSpeech', { text: dangerSpeech });
    io.emit('workoutState', getWorkoutStatePayload());
}

function confirmDangerEscape() {
    isDangerActive = false;
    currentStatus = 'NORMAL';
    lockedBarValue = null; // 바 위치 고정 해제!
    awaitingDangerEscapeConfirm = false;
    dangerCooldownUntil = Date.now() + 3000;
    if (port && port.isOpen) port.write('N\n');

    const clearDecision = "안전 고정을 해제했습니다.";
    const speechText = "바 고정을 해제합니다.";

    console.log(`\n[시나리오 3] 바텀 위험 탈출 확인 -> 바 고정 해제 & NORMAL 정상 복귀`);
    io.emit('sensorData', {
        value: lastValue,
        status: 'NORMAL',
        isDangerActive: false,
        lockedBarValue: null,
        awaitingDangerEscapeConfirm: false,
        decision: clearDecision
    });
    io.emit('agentSpeech', { text: speechText });
    io.emit('workoutState', getWorkoutStatePayload());
}

// 상-하 연속 움직임 감지(Repetition) 및 자동 세트/휴식 판별 알고리즘
function trackRepetition(value) {
    const now = Date.now();

    // 1. Rep 상태 머신 (FSM)
    if (repStage === 'WAITING_START') {
        if (value > THRESHOLD_BOTTOM + 80) { // 360 이상으로 당기기 시작
            repStage = 'GOING_UP';
            repStartTime = now;
            peakValue = value;
            currentRepAssistCount = 0; // 새 Rep 시작 시 감량 카운트 리셋
            bottomMoveStartTime = 0;
            lastBottomMoveTimestamp = 0;
            bottomStillStartTime = 0;

            if (currentSetStartTime === 0) {
                currentSetStartTime = now;
                if (restStartTime > 0) {
                    lastSetRestDurationSec = Math.floor((now - restStartTime) / 1000);
                }
            }
            // (위험 상태 자동 해제 금지: 위험 상태는 가변저항 상승으로 자동 해제되지 않으며, 사용자 안부 대화나 해제 버튼으로만 안전하게 해제됨)

            if (isResting) {
                // 휴식 상태에서 당기기 시작하면 자동으로 새 세트 시작
                isResting = false;
                console.log(`\n[운동 재개] Set ${currentSet} 시작!`);
                io.emit('workoutState', getWorkoutStatePayload());
            }
        }
    } else if (repStage === 'GOING_UP') {
        if (value > peakValue) peakValue = value;
        if (value >= THRESHOLD_TOP) {
            repStage = 'AT_TOP';
            // ⭐️ 무게 부담(ASSIST)은 top을 넘어서면 해제! (감소된 부하 강도는 유지)
            if (currentStatus === 'ASSIST') {
                currentStatus = 'NORMAL';
                midStallStartTime = 0;
                console.log(`\n[TOP 달성] 상단 도달 -> 무게 부담(ASSIST) 상태 해제 (부하 감소 Lv.${assistLevel}, ${userWeightKg}kg 유지)`);
                if (port && port.isOpen) port.write('N\n');
                io.emit('sensorData', {
                    value: value,
                    status: 'NORMAL',
                    assistLevel: assistLevel,
                    loadKg: userWeightKg,
                    userWeightKg: userWeightKg
                });
            }
        } else if (value <= THRESHOLD_BOTTOM) {
            // 충분히 오르지 못하고 바로 내려온 경우 초기화
            repStage = 'WAITING_START';
            midStallStartTime = 0;
            currentRepAssistCount = 0;
            if (currentStatus === 'ASSIST') {
                currentStatus = 'NORMAL';
                console.log(`\n[바텀 복귀] 바텀 도달로 인해 임시 ASSIST 해제 -> NORMAL (줄어든 무게 ${userWeightKg}kg 유지)`);
                if (port && port.isOpen) port.write('N\n');
                io.emit('sensorData', {
                    value: value,
                    status: 'NORMAL',
                    assistLevel: assistLevel,
                    loadKg: userWeightKg,
                    userWeightKg: userWeightKg,
                    decision: "바텀 위치로 복귀했습니다.\n호흡을 가다듬고 준비되시면 다시 당겨주세요."
                });
                io.emit('workoutState', getWorkoutStatePayload());
            }
        }
    } else if (repStage === 'AT_TOP') {
        if (value > peakValue) peakValue = value;
        if (value < THRESHOLD_TOP - 80) { // 최고점 찍고 하강 시작
            repStage = 'GOING_DOWN';
        }
    } else if (repStage === 'GOING_DOWN') {
        if (value <= THRESHOLD_BOTTOM) {
            // 🎉 1 Rep 완료 (상-하 사이클 완수)
            const durationSec = Math.max(0.4, (now - repStartTime) / 1000);

            if (durationSec >= 0.4) {
                currentSetReps++;
                totalReps++;
                lastRepDuration = durationSec;
                lastRepTimestamp = now;
                recentTempos.push(durationSec);
                if (recentTempos.length > 20) recentTempos.shift();

                const avgTempo = recentTempos.reduce((a, b) => a + b, 0) / recentTempos.length;
                const romRatingVal = peakValue >= 860 ? 'PERFECT' : (peakValue >= 740 ? 'GOOD' : 'PARTIAL');

                currentSetTempos.push(Number(durationSec.toFixed(1)));
                currentSetRoms.push(romRatingVal);
                currentSetPeaks.push(peakValue);

                // Rep 달성 성공 시: 무게 부담 상태(ASSIST)는 해제하되, 감소된 강도(assistLevel)는 쭉 유지!
                if (currentStatus === 'ASSIST') {
                    currentStatus = 'NORMAL';
                    midStallStartTime = 0;
                    if (port && port.isOpen) port.write('N\n');
                }
                currentRepAssistCount = 0; // 랩 완수 시 감량 카운트 리셋

                // 💡 운동 진행 중 피로 누적(Fatigue / Velocity Loss) 자동 감지 및 선제 부하 감경:
                // 2회차 이상 수행 중, 이번 랩 수행 시간이 3.8초 이상 걸렸거나 이전 평균 대비 40% 이상 지체된 경우
                // (단, 불균형 교정 모드 중이거나 본 운동 확인 대기 중에는 교정 부하 20kg 유지를 위해 추가 감량 차단)
                if (currentSetReps >= 2 && durationSec >= 3.8 && (now - lastAssistTimestamp >= 4500) && !isImbalanceActive && !awaitingMainWorkoutConfirm) {
                    const prevTempos = currentSetTempos.slice(0, -1);
                    const prevAvg = prevTempos.length > 0 ? (prevTempos.reduce((a, b) => a + b, 0) / prevTempos.length) : 2.4;
                    if (durationSec >= prevAvg * 1.4 || durationSec >= 4.0) {
                        console.log(`\n[피로 누적 감지] Rep 템포 지체 (${durationSec.toFixed(1)}s, 이전 평균: ${prevAvg.toFixed(1)}s) -> 다음 반복을 위해 5kg 선제 감량`);
                        setTimeout(() => {
                            if (!isResting && currentStatus !== 'DANGER' && !isDangerActive && !isImbalanceActive && !awaitingMainWorkoutConfirm) {
                                applyAssistWeightReduction(`피로 누적 감지 (${durationSec.toFixed(1)}초 소요)`, 'fatigue_slowdown', lastValue);
                            }
                        }, 500);
                    }
                }

                const pureKoreanNumbers = [
                    '', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열',
                    '열하나', '열둘', '열셋', '열넷', '열다섯', '열여섯', '열일곱', '열여덟', '열아홉', '스물',
                    '스물하나', '스물둘', '스물셋', '스물넷', '스물다섯', '스물여섯', '스물일곱', '스물여덟', '스물아홉', '서른',
                    '서른하나', '서른둘', '서른셋', '서른넷', '서른다섯', '서른여섯', '서른일곱', '서른여덟', '서른아홉', '마흔',
                    '마흔하나', '마흔둘', '마흔셋', '마흔넷', '마흔다섯', '마흔여섯', '마흔일곱', '마흔여덟', '마흔아홉', '쉰'
                ];
                const countWord = currentSetReps < pureKoreanNumbers.length ? pureKoreanNumbers[currentSetReps] : `${currentSetReps}`;
                console.log(`[Rep 달성] Set ${currentSet} - ${currentSetReps}회(${countWord}) 완료! (템포: ${durationSec.toFixed(1)}s, ROM: ${romRatingVal}, 부하: ${getCurrentLoadKg()}kg [Lv.${assistLevel}])`);

                io.emit('repCompleted', {
                    currentSet,
                    reps: currentSetReps,
                    countWord: countWord,
                    totalReps,
                    duration: Number(durationSec.toFixed(1)),
                    avgTempo: Number(avgTempo.toFixed(1)),
                    rom: romRatingVal,
                    assistLevel: assistLevel,
                    loadKg: getCurrentLoadKg(),
                    userWeightKg: userWeightKg
                });
            }

            repStage = 'WAITING_START';
            peakValue = 0;
        }
    }
}

function completeCurrentSet(now) {
    if (isResting || currentSetReps < 1) return;
    isResting = true;
    lastAssistTimestamp = 0;
    bottomMoveStartTime = 0;
    lastBottomMoveTimestamp = 0;
    bottomStillStartTime = 0;
    midStallStartTime = 0;
    restStartTime = now || Date.now();
    const avgTempo = recentTempos.length > 0
        ? recentTempos.reduce((a, b) => a + b, 0) / recentTempos.length
        : lastRepDuration;

    const nowObj = new Date();
    const dateStr = getFormattedDate(nowObj);
    const completedAtStr = nowObj.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const durationSec = currentSetStartTime > 0 ? Math.round((now - currentSetStartTime) / 1000) : Math.round(currentSetReps * 2.4);

    const completedSetInfo = createDetailedSetRecord({
        setId: `set_${nowObj.getTime()}`,
        date: dateStr,
        set: currentSet,
        startTime: currentSetStartTime > 0 ? new Date(currentSetStartTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : completedAtStr,
        completedAt: completedAtStr,
        durationSeconds: durationSec,
        reps: currentSetReps,
        targetReps: aiTargetReps,
        baseWeightKg: userWeightKg,
        startLoadKg: currentSetStartWeightKg,
        startIntensityPercent: Math.round(Math.max(0.2, 1 - currentSetStartLevel * 0.15) * 100),
        finalLoadKg: getCurrentLoadKg(),
        finalIntensityPercent: Math.round(Math.max(0.2, 1 - assistLevel * 0.15) * 100),
        assistLevel: assistLevel,
        loadChangeHistory: [...currentSetLoadChanges],
        assistCount: currentSetAssistTriggers,
        dangerCount: currentSetDangerTriggers,
        repTempos: currentSetTempos.length > 0 ? [...currentSetTempos] : (recentTempos.length > 0 ? [...recentTempos] : [Number(lastRepDuration.toFixed(1))]),
        repRoms: currentSetRoms.length > 0 ? [...currentSetRoms] : [],
        restBeforeSetSeconds: lastSetRestDurationSec,
        recommendedRestSeconds: aiRestTimeSeconds,
        coachFeedbackSnippet: latestCoachFeedback || "페이스를 유지하며 세트를 잘 완수했습니다."
    });

    setHistory.push(completedSetInfo);

    console.log(`\n[세트 완료: 완전 정지 휴식] Set ${currentSet} 종료: ${currentSetReps}회 (평균 템포: ${completedSetInfo.avgTempo}s, 최종부하: ${completedSetInfo.finalLoadKg}kg [Lv.${assistLevel}]) -> 휴식 모드 진입 (남은 휴식: ${aiRestTimeSeconds}초)`);

    io.emit('setCompleted', {
        completedSet: completedSetInfo,
        nextSet: currentSet + 1,
        setHistory,
        targetRestTime: aiRestTimeSeconds,
        assistLevel: assistLevel,
        currentLoadKg: getCurrentLoadKg(),
        userWeightKg: userWeightKg
    });

    currentSet++;
    currentSetReps = 0;
    recentTempos = [];
    currentSetStartTime = 0;
    currentSetTempos = [];
    currentSetRoms = [];
    currentSetPeaks = [];
    currentSetLoadChanges = [];
    currentSetAssistTriggers = 0;
    currentSetDangerTriggers = 0;
    currentSetStartWeightKg = getCurrentLoadKg();
    currentSetStartLevel = assistLevel;
}

// 1초마다 남은 휴식 시간 브로드캐스트
setInterval(() => {
    if (isResting) {
        const restSec = Math.floor((Date.now() - restStartTime) / 1000);
        const remainingSec = Math.max(0, aiRestTimeSeconds - restSec);
        io.emit('restTick', {
            restSeconds: restSec,
            targetRestTime: aiRestTimeSeconds,
            remainingSeconds: remainingSec
        });
    }
}, 1000);

function processSensorValue(value) {
    if (isNaN(value)) return;
    value = Math.max(0, Math.min(1023, value));
    lastValue = value;
    const now = Date.now();

    // 🔒 1. 신체 이탈 상태일 때: 바 위치 즉시 고정 (가변저항 움직임 무시)
    if (isBodyDetached) {
        const freezeVal = lockedBarValue !== null ? lockedBarValue : value;
        io.emit('sensorData', {
            value: freezeVal,
            status: 'BODY_DETACHED',
            isBodyDetached: true,
            lockedBarValue: freezeVal,
            decision: "경고: 신체 이탈 감지!\n바에서 손이 떨어져 바의 위치를 안전하게 고정했습니다."
        });
        return;
    }

    // 🚨 2. 바텀 탈진(DANGER) 상태일 때: 바를 안전 라인(280)에 고정 (가변저항 무시 및 대화 해제 대기)
    if (isDangerActive || currentStatus === 'DANGER') {
        io.emit('sensorData', {
            value: THRESHOLD_BOTTOM,
            status: 'DANGER',
            isDangerActive: true,
            lockedBarValue: THRESHOLD_BOTTOM,
            awaitingDangerEscapeConfirm: awaitingDangerEscapeConfirm,
            decision: "경고: 바텀 탈진 위험 감지!\n바를 안전 라인(280)에 고정했습니다.\n사용자님, 괜찮으신가요? 안전하게 빠져나오셨나요?"
        });
        return;
    }

    sensorDataBuffer.push(value);
    if (sensorDataBuffer.length > 50) sensorDataBuffer.shift();

    // 빠른 움직임 감지용 버퍼 유지 (최근 데이터 최대 15개, 약 1.5초)
    recentDataBuffer.push(value);
    if (recentDataBuffer.length > 15) recentDataBuffer.shift();

    // 초기값 대비 움직임이 발생하면 사용자가 운동을 개시한 것으로 간주
    if (!hasUserInteracted && (value > THRESHOLD_BOTTOM + 80 || currentSetReps > 0 || totalReps > 0)) {
        hasUserInteracted = true;
        if (userWeightKg === 0) {
            userWeightKg = 60.0;
            currentSetStartWeightKg = 60.0;
            console.log(`\n[자율 운동 개시] 바 움직임 감지 -> 기본 부하 ${userWeightKg}kg 활성화`);
            io.emit('sensorData', {
                value: value,
                status: currentStatus,
                assistLevel: assistLevel,
                loadKg: userWeightKg,
                userWeightKg: userWeightKg
            });
            io.emit('workoutState', getWorkoutStatePayload());
        }
    }

    // 운동량(반복수 및 세트) 실시간 추적
    trackRepetition(value);

    // 최근 1~1.5초간의 변동폭 측정 (움직임 여부 판별)
    const rMax = Math.max(...recentDataBuffer);
    const rMin = Math.min(...recentDataBuffer);
    const recentDiff = rMax - rMin;

    const BOTTOM_ZONE_LIMIT = THRESHOLD_BOTTOM + 140; // 420 이하를 바텀 구간으로 판별

    // =========================================================================
    // [구간 1] 바텀 구간 (<= 420) 체류 시 판정: 탈진 위험(DANGER) vs 세트 완료(휴식)
    // =========================================================================
    if (value <= BOTTOM_ZONE_LIMIT) {
        midStallStartTime = 0; // 중간 정체 타이머 리셋

        // ⭐️ 바텀 구간 진입 시 임시 ASSIST 상태는 NORMAL 복구 (줄어든 무게는 유지)
        if (currentStatus === 'ASSIST') {
            currentStatus = 'NORMAL';
            if (port && port.isOpen) port.write('N\n');
        }

        // 특수 상태 플래그 확인 (이미 DANGER이거나 불균형 또는 신체 이탈 상태일 때는 바텀 위험/휴식 판정만 건너뛰고 정상 센서 송신 계속 진행!)
        const isSpecialScenario = currentStatus === 'DANGER' || isDangerActive || isImbalanceActive || awaitingMainWorkoutConfirm || isBodyDetached;

        if (isSpecialScenario) {
            bottomMoveStartTime = 0;
            bottomStillStartTime = 0;
            // (특수 시나리오 진행 중에는 바텀 체류에 의한 위험/휴식 자동 전환을 스킵하고 아래 센서 브로드캐스트로 직행)
        } else {
            // ⭐️ [쉬는 상황 vs 위험 감지 명확한 분리]
            // A. 바텀 탈진 위험(DANGER):
            //    - 사용자가 손을 놓지 못하고 바텀 구간에서 꼼질거리며 발버둥치는 상태 (recentDiff >= 15)
            //    - 휴식 중이 아니며(!isResting), 쿨다운이 아닐 때, 꼼질거림이 2.5초 이상 지속되면 위험 발동!
            const DANGER_DIFF_THRESHOLD = 15; // 꼼질거림 발버둥 임계값
            const isStruggling = recentDiff >= DANGER_DIFF_THRESHOLD;

            if (isStruggling && !isResting && now >= dangerCooldownUntil) {
                // 발버둥치는 중이므로 쉬는 타이머는 리셋
                bottomStillStartTime = 0;

                if (bottomMoveStartTime === 0) {
                    bottomMoveStartTime = now;
                }

                const dangerStayDuration = now - bottomMoveStartTime;
                if (dangerStayDuration >= DANGER_TRIGGER_MS) {
                    if (currentStatus !== 'DANGER' && !isDangerActive) {
                        bottomMoveStartTime = 0;
                        bottomStillStartTime = 0;
                        triggerDangerScenario('hardware_sensor', `바텀 탈진 꼼질거림 위험 감지 (${(dangerStayDuration / 1000).toFixed(1)}초 지속)`);
                        return;
                    }
                }
            } else {
                // 발버둥치지 않거나 휴식 중이면 위험 타이머 즉시 리셋 (쉬는 상황 보호)
                bottomMoveStartTime = 0;

                // B. 쉬는 상황 (휴식 및 세트 완료 / 평화로운 대기):
                //    - 손을 놓고 가만히 멈춰있는 상태 (recentDiff < 15)
                //    - 세트 진행 중(1회 이상 성공)이고 휴식 전이면, 3.5초 정지 시 세트 완료 및 휴식 모드 진입
                if (!isResting && currentSetReps >= 1 && repStage === 'WAITING_START' && !isStruggling) {
                    if (bottomStillStartTime === 0) {
                        bottomStillStartTime = now;
                    }
                    const stillDuration = now - bottomStillStartTime;
                    if (stillDuration >= SET_COMPLETE_STILL_MS) {
                        completeCurrentSet(now);
                        bottomStillStartTime = 0;
                    }
                } else {
                    bottomStillStartTime = 0;
                }
            }
        }
    }
    // =========================================================================
    // [구간 2] 바텀 구간 탈출 (> 380) 시
    // =========================================================================
    else {
        bottomMoveStartTime = 0;
        lastBottomMoveTimestamp = 0;
        bottomStillStartTime = 0;

        // 🚨 바텀 위험(DANGER) 상태이거나 특수 상황일 때는 ASSIST 감경 스킵
        if (currentStatus === 'DANGER' || isDangerActive || isImbalanceActive || awaitingMainWorkoutConfirm) {
            // 특수 모드 진행 중에는 스마트 ASSIST 자동 감경 생략
        } else {
            // ⭐️ 바텀과 탑 사이 중간 정체 판별 -> 사용자 무게 부담 (다단계 ASSIST)
            // 조건:
            // 1. 바텀을 벗어난 중상단 구간 (value >= THRESHOLD_BOTTOM + 140 = 420 이상)
            // 2. 탑(740) 도달 직전 미만 (value < THRESHOLD_TOP - 40 = 700 미만)
            // 3. 휴식 상태 및 특수 모드가 아님
            const isMidStallZone = (value >= THRESHOLD_BOTTOM + 140) &&
                (value < THRESHOLD_TOP - 40) &&
                !isResting &&
                !isImbalanceActive &&
                !awaitingMainWorkoutConfirm;

            if (isMidStallZone) {
                // 실제 정체 상태: 움직임이 멈칫거림 (손떨림 고려: recentDiff < 95)
                if (recentDiff < 95) {
                    if (midStallStartTime === 0) {
                        midStallStartTime = now;
                    }

                    const stallDuration = now - midStallStartTime;
                    // 1) 최초 정체 3초 경과 (MID_STALL_TRIGGER_MS: 3000ms)
                    // 2) 직전 감량 후 최소 5초 경과 (CONT_STALL_TRIGGER_MS: 5000ms)
                    // 3) 최저 무게(10kg) 초과일 때만 발동
                    // (1랩 완수 제한 없이 정체 지속 시 5초마다 누적 감량)
                    const canTriggerAssist = (stallDuration >= MID_STALL_TRIGGER_MS) &&
                        (now - lastAssistTimestamp >= CONT_STALL_TRIGGER_MS) &&
                        (userWeightKg > 10.0);

                    if (canTriggerAssist) {
                        applyAssistWeightReduction(`정체 감지 (${(stallDuration / 1000).toFixed(0)}초)`, 'mid_stall_direct_weight', value);
                    }
                }
                // 뚜렷한 움직임이 있을 때는 정체 타이머 리셋
                else {
                    midStallStartTime = 0;
                }
            } else {
                midStallStartTime = 0;
                // TOP 도달 시 감량된 무게 유지하며 정상 상태 복귀 (알림 및 안내 없이 조용히 NORMAL 복귀)
                if (currentStatus === 'ASSIST' && value >= THRESHOLD_TOP) {
                    currentStatus = 'NORMAL';
                    console.log(`\n[TOP 달성] 상단 도달 -> 무게 감량(${userWeightKg}kg, Lv.${assistLevel}) 유지`);
                    if (port && port.isOpen) port.write('N\n');
                    io.emit('sensorData', {
                        value: value,
                        status: 'NORMAL',
                        assistLevel: assistLevel,
                        loadKg: userWeightKg,
                        userWeightKg: userWeightKg
                    });
                    io.emit('workoutState', getWorkoutStatePayload());
                }
            }
        }
    }

    // 센서 값 및 상태 플래그 실시간 웹 브로드캐스트
    io.emit('sensorData', {
        value: (isDangerActive || currentStatus === 'DANGER') ? THRESHOLD_BOTTOM : (isBodyDetached ? (lockedBarValue !== null ? lockedBarValue : value) : value),
        status: currentStatus,
        isDangerActive: isDangerActive,
        isBodyDetached: isBodyDetached,
        isImbalanceActive: isImbalanceActive,
        isWeightLocked: isWeightLocked,
        awaitingMainWorkoutConfirm: awaitingMainWorkoutConfirm,
        awaitingDangerEscapeConfirm: awaitingDangerEscapeConfirm,
        assistLevel: assistLevel,
        loadKg: getCurrentLoadKg(),
        userWeightKg: userWeightKg
    });
}

let activePortPath = ARDUINO_PORT;
let isPortConnecting = false;

async function findArduinoPort() {
    try {
        const ports = await SerialPort.list();
        const arduino = ports.find(p =>
            (p.vendorId && p.vendorId.toLowerCase() === '2341') ||
            (p.manufacturer && p.manufacturer.toLowerCase().includes('arduino')) ||
            (p.friendlyName && p.friendlyName.toLowerCase().includes('arduino')) ||
            (p.path === ARDUINO_PORT)
        );
        if (arduino) return arduino.path;
        const defaultPort = ports.find(p => p.path === ARDUINO_PORT);
        if (defaultPort) return defaultPort.path;
    } catch (e) {
        // scan error fallback
    }
    return ARDUINO_PORT;
}

function initSerialConnection() {
    if (isPortConnecting || (port && port.isOpen)) return;
    isPortConnecting = true;

    findArduinoPort().then((targetPath) => {
        activePortPath = targetPath || ARDUINO_PORT;
        try {
            port = new SerialPort({ path: activePortPath, baudRate: BAUD_RATE, autoOpen: false });
            const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

            console.log(`[하드웨어] 아두이노 포트 연결 시도: ${activePortPath}...`);

            port.open((err) => {
                isPortConnecting = false;
                if (err) {
                    console.log(`[하드웨어 대기] 아두이노(${activePortPath}) 연결 대기 중... (${err.message})`);
                    io.emit('arduinoStatus', { connected: false, port: activePortPath });
                } else {
                    console.log(`\n========================================`);
                    console.log(`[하드웨어 연결 완료] 아두이노(${activePortPath}) 실시간 VBT 센서 스트리밍 준비됨!`);
                    console.log(`========================================\n`);
                    io.emit('arduinoStatus', { connected: true, port: activePortPath });
                    io.emit('workoutState', getWorkoutStatePayload());
                }
            });

            port.on('error', (err) => {
                console.log('[시리얼 포트 알림]:', err.message);
                io.emit('arduinoStatus', { connected: false, port: activePortPath });
            });

            port.on('close', () => {
                console.log('[시리얼 포트 알림]: 아두이노 연결이 종료되었습니다. 자동 재연결을 시도합니다.');
                io.emit('arduinoStatus', { connected: false, port: activePortPath });
            });

            // 아두이노에서 데이터 수신 (센서값 또는 시나리오 버튼 이벤트)
            parser.on('data', (data) => {
                const raw = data.trim();
                if (raw === 'BTN1_PRESS' || raw === 'BTN1') {
                    toggleBodyDetachment('hardware_button_1 (Pin 11)');
                } else if (raw === 'BTN2_PRESS' || raw === 'BTN2') {
                    toggleImbalanceScenario('hardware_button_2 (Pin 12)');
                } else {
                    const value = parseInt(raw, 10);
                    if (!isNaN(value)) {
                        processSensorValue(value);
                    }
                }
            });

        } catch (error) {
            isPortConnecting = false;
            console.log("[안내] SerialPort 초기화 예외:", error.message);
        }
    }).catch(() => {
        isPortConnecting = false;
    });
}

initSerialConnection();

// 아두이노 미연결 시 3초 주기로 자동 재연결 시도
setInterval(() => {
    if (!port || !port.isOpen) {
        initSerialConnection();
    }
}, 3000);

// (6초 주기 불필요한 자동 LLM 폴링 제거: 사용자가 질문하거나 실제 물리적 이벤트 발생 시에만 피드백 출력)

async function analyzeWithLLM(dataArray) {
    isAnalyzing = true;

    const maxVal = Math.max(...dataArray);
    const minVal = Math.min(...dataArray);
    const diff = maxVal - minVal;

    try {
        const avgVal = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        // 실시간 안전 상태(DANGER, ASSIST)를 최우선으로 반영 (LLM이 잘못된 상태로 덮어쓰지 않도록 보장)
        let systemStatus = (currentStatus === 'DANGER' || isDangerActive) ? 'DANGER' : (currentStatus === 'ASSIST' ? 'ASSIST' : 'NORMAL');
        let hwSignal = systemStatus === 'DANGER' ? 'H' : (systemStatus === 'ASSIST' ? 'L' : 'N');

        const avgTempo = recentTempos.length > 0
            ? (recentTempos.reduce((a, b) => a + b, 0) / recentTempos.length).toFixed(1)
            : (lastRepDuration > 0 ? lastRepDuration.toFixed(1) : "2.0");

        let workoutContext = "";
        if (isDangerActive || currentStatus === 'DANGER') {
            workoutContext = `[현재 상태: 바텀 탈진 위험 감지로 안전 바 자동 리프트 작동 상태 (절대 휴식 아님)] 현재 ${currentSet}세트 중이며, 위험 감지로 바가 Bottom 안전 라인에 고정되었습니다. 절대 '휴식'이라는 단어를 쓰지 말고 안전 경고 및 자세 정비를 안내하세요.`;
        } else if (isResting) {
            const restSec = Math.floor((Date.now() - restStartTime) / 1000);
            const remainingSec = Math.max(0, aiRestTimeSeconds - restSec);
            const lastSet = setHistory[setHistory.length - 1];
            workoutContext = `[현재 상태: 세트 종료 후 휴식 중] 직전 ${lastSet ? lastSet.set : 1}세트에서 ${lastSet ? lastSet.reps : 0}회 성공. 남은 권장 휴식 시간: ${remainingSec}초. 다음 ${currentSet}세트 대기 중.`;
        } else {
            workoutContext = `[현재 상태: 세트 진행 중 (절대 휴식 모드 아님)] 현재 ${currentSet}세트 수행 중이며, 이번 세트에서 ${currentSetReps}회(총 누적: ${totalReps}회) 반복 완료. 최근 템포: ${avgTempo}초/회. 현재 센서 평균 위치: ${avgVal.toFixed(0)}.`;
        }

        // Qwen에게 보낼 프롬프트 (전문 스마트 VBT AI 코치 역할 부여)
        const prompt = `당신은 LG전자의 스마트 AI 퍼스널 트레이너 'LG Well'입니다.
사용자 실시간 운동 현황:
${workoutContext}
시스템 안전 상태 판정: "${systemStatus}" (변동폭: ${diff})

지시사항:
- 가독성을 위해 각 문장마다 반드시 줄바꿈(\\n)을 넣어 작성하세요.
- 상태가 "DANGER"인 경우: 바텀 탈진으로 안전 리프트가 작동되어 바가 고정된 비상 안전 상태입니다. **절대로 '휴식'이라는 단어나 '쉬라'는 표현을 사용하지 마세요.** "경고: 한계 도달 (탈진 감지)!\\n바를 안전 라인에 고정했습니다.\\n무리하지 말고 안전하게 내려오세요." 형태로 안전 경고를 작성하세요.
- 상태가 "ASSIST"인 경우: 바텀과 탑 사이에서 정체된 상태입니다. 다른 어떤 부가 설명도 붙이지 말고 반드시 "정체 감지.\\n무게 5kg 감소합니다."라고만 작성하세요.
- 상태가 "NORMAL"이고 [세트 진행 중]인 경우:
  * 현재 사용자가 한창 힘을 쓰며 운동 중이므로 **'휴식'이라는 단어나 '쉬라'는 말을 절대로 사용하지 마세요.**
  * 현재 반복수(${currentSetReps}회)와 템포(${avgTempo}초)를 언급하며 바를 계속 당기도록 격려하고 자세를 지도하세요.
- 상태가 "NORMAL"이고 [세트 종료 후 휴식 중]인 경우:
  * 직전 세트의 수고를 인정하고, 남은 휴식 시간 동안 호흡을 정리하라고 안내하세요.
  * 다음 세트 목표 횟수(nextTargetReps)와 권장 휴식 시간(restTimeSeconds)을 동적으로 판단하여 설정하세요.

반드시 아래 JSON 형식으로만 답변하세요 (다른 텍스트나 마크다운은 절대 추가하지 마세요):
{
  "status": "${systemStatus}",
  "action": "첫 번째 문장입니다.\\n두 번째 문장입니다.",
  "hardware_signal": "${hwSignal}",
  "nextTargetReps": ${aiTargetReps},
  "restTimeSeconds": ${aiRestTimeSeconds}
}`;

        // Ollama API 로컬 호출 (Node 18+ fetch 사용)
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen2.5:1.5b', // 현재 설치된 모델명 (qwen2.5:1.5b 또는 qwen2.5:7b)
                prompt: prompt,
                stream: false,
                format: 'json' // JSON 형태의 응답을 강제함
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama 서버 에러: ${response.status}`);
        }

        const result = await response.json();
        let jsonStr = result.response;

        // 마크다운 제거 처리 (```json ... ```)
        if (jsonStr.includes('\`\`\`')) {
            jsonStr = jsonStr.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
        }

        const llmReply = JSON.parse(jsonStr);

        // LLM이 지시를 무시하고 오판(환각)할 경우를 대비해, 상태값은 시스템 판별값을 강제 적용
        llmReply.status = systemStatus;
        llmReply.hardware_signal = hwSignal;

        if (llmReply.nextTargetReps && !isNaN(llmReply.nextTargetReps)) {
            aiTargetReps = parseInt(llmReply.nextTargetReps, 10);
        }
        // 사용자가 직접 설정한 휴식 시간이 아닐 때만 LLM의 제안을 반영하여 사용자 설정을 영구 보호
        if (!isUserCustomRestTime && llmReply.restTimeSeconds && !isNaN(llmReply.restTimeSeconds)) {
            aiRestTimeSeconds = parseInt(llmReply.restTimeSeconds, 10);
        }

        // DANGER 상태이거나 세트 진행 중일 때 '휴식' 관련 단어 절대 포함 금지 (서버 강제 필터)
        if ((!isResting || currentStatus === 'DANGER' || isDangerActive) && llmReply.action) {
            if (/휴식|쉬고|쉬세|쉬어|쉬입|휴식하/.test(llmReply.action)) {
                if (currentStatus === 'DANGER' || isDangerActive) {
                    llmReply.action = `경고: 한계 도달 (탈진 감지)!\n바를 안전 라인에 고정했습니다.\n무리하지 말고 안전하게 내려오세요.`;
                } else {
                    llmReply.action = `좋은 페이스입니다 (${currentSetReps}회 진행 중)!\n호흡을 가다듬고 끝까지 힘을 내세요!`;
                }
            }
        }

        // Qwen 모델이 문구를 짓지 않고 지시문을 그대로 복사하는 경우를 대비한 기본 텍스트(Fallback)
        if (!llmReply.action || llmReply.action.includes('작성') || llmReply.action.includes('여기에') || llmReply.action.includes('첫 번째 문장')) {
            if (systemStatus === 'DANGER') {
                llmReply.action = "경고: 한계 도달 (탈진 감지)!\n바가 안전 위치로 이동되었습니다.\n무리하지 말고 안전하게 내려오세요.";
            } else if (systemStatus === 'ASSIST') {
                llmReply.action = "정체 감지.\n무게 5kg 감소합니다.";
            } else if (isResting) {
                llmReply.action = `수고하셨습니다!\n남은 휴식 시간 동안 호흡을 정리하세요.\n다음 세트 목표는 ${aiTargetReps}회 도전입니다!`;
            } else {
                llmReply.action = `페이스가 좋습니다 (${currentSetReps}회 진행 중)!\n집중력을 유지하며 끝까지 당겨주세요!`;
            }
        }

        if (llmReply.action) {
            llmReply.action = llmReply.action.replace(/\[LG Well\]/gi, '').trim();
            latestCoachFeedback = llmReply.action;
        }

        if (currentStatus === 'ASSIST' || systemStatus === 'ASSIST') {
            llmReply.action = "정체 감지.\n무게 5kg 감소합니다.";
            latestCoachFeedback = llmReply.action;
        }

        currentStatus = (currentStatus === 'DANGER' || isDangerActive) ? 'DANGER' : (currentStatus === 'ASSIST' ? 'ASSIST' : llmReply.status);
        console.log("[LLM 코치 피드백]:", llmReply.action);

        // 아두이노로 하드웨어 제어 신호(H 또는 L 또는 N) 전송
        const finalSignal = currentStatus === 'DANGER' ? 'H' : (currentStatus === 'ASSIST' ? 'L' : 'N');
        if (port && port.isOpen) {
            port.write(finalSignal + '\n');
        }

        // 웹 대시보드로 AI의 최종 판단 텍스트 전송
        io.emit('sensorData', {
            value: lastValue,
            status: currentStatus,
            assistLevel: assistLevel,
            loadKg: getCurrentLoadKg(),
            userWeightKg: userWeightKg,
            decision: llmReply.action
        });

        // 상태값(목표 등)이 바뀌었으므로 상태 동기화 재요청
        io.emit('workoutState', getWorkoutStatePayload());

    } catch (error) {
        console.error("LLM API 통신 오류:", error.message);
        io.emit('sensorData', {
            value: lastValue,
            status: 'ERROR',
            decision: "[시스템 오류] 로컬 LLM(Ollama) 서버 응답 실패. (Ollama 켜짐 및 모델명 확인 요망)"
        });
    } finally {
        isAnalyzing = false;
    }
}

// =================== 로컬 LLM(Ollama) 실시간 대화형 챗 코칭 엔진 ===================
async function chatWithLLM(userMessage, contextData = {}) {
    const currentLoad = getCurrentLoadKg();
    const statusText = currentStatus === 'DANGER' ? '위험 안전 고정 (SAFETY HOLD)'
        : (currentStatus === 'ASSIST' ? `무게 보조(부하 감경 Lv.${assistLevel})`
            : (isResting ? '세트 간 휴식 중' : '정상 운동 중'));

    const systemPrompt = `당신은 스마트 풀업 머신의 'AI 퍼스널 트레이너 코치'입니다.
사용자가 운동 중 당신에게 질문을 하거나 대화를 건넸습니다.
아래의 [실시간 운동 맥락]을 바탕으로, 전문적이고 친절하며 동기부여가 넘치는 코치로서 간결하게 답변하세요.
반드시 한국어로 1~2문장(최대 3문장) 이내의 짧고 또렷한 구어체로만 답변하세요. 마크다운 기호(*, #, - 등)나 대괄호는 일절 쓰지 마세요.

[실시간 운동 맥락]
- 현재 진행: ${currentSet}세트 진행 중 (목표: ${aiTargetSets}세트)
- 세트 내 횟수: ${currentSetReps}회 완료 (목표: ${aiTargetReps}회)
- 총 누적 반복: ${totalReps}회
- 현재 운동 부하: ${currentLoad.toFixed(1)}kg (기준 체중: ${userWeightKg.toFixed(1)}kg)
- 머신 상태: ${statusText}
- 현재 단계: ${isResting ? '세트 종료 후 휴식 타이머 진행 중' : (repStage === 'GOING_UP' ? '바를 위로 당겨 올리는 중' : '바텀 대기 중')}

사용자 질문: "${userMessage}"`;

    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen2.5:1.5b',
                prompt: systemPrompt,
                stream: false
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama HTTP Error: ${response.status}`);
        }

        const data = await response.json();
        let reply = (data.response || '').trim();
        reply = reply.replace(/[#*`\[\]]/g, '').replace(/\n{2,}/g, '\n').trim();
        return reply || `네! 현재 ${currentSet}세트에서 ${currentLoad.toFixed(1)}kg으로 운동 중이십니다. 페이스를 유지하며 끝까지 완수해 보세요!`;
    } catch (err) {
        console.error('[로컬 LLM 챗 오류]:', err.message);
        return `현재 ${currentSet}세트 목표 ${aiTargetReps}회 달성을 위해 바른 자세와 호흡에 집중해 주세요. 끝까지 힘내세요!`;
    }
}

io.on('connection', (socket) => {
    console.log('A web client connected.');

    // 클라이언트 접속 시 현재까지의 운동 상태(세트, 횟수, 히스토리 등) 및 하드웨어 연결 상태 즉시 전송
    socket.emit('workoutState', getWorkoutStatePayload());
    socket.emit('arduinoStatus', { connected: Boolean(port && port.isOpen), port: activePortPath });

    // 로컬 LLM 챗 질문 수신 및 실시간 생성 답변 전송
    socket.on('userChatMessage', async (data) => {
        const msg = (data && data.message ? data.message : '').trim();
        if (!msg) return;
        console.log(`\n[로컬 LLM 챗 질문]: "${msg}"`);
        const lower = msg.toLowerCase();

        // 👋 가벼운 일상 인사말 처리 (불필요한 운동 맥락 분석 방지)
        if (/^(?:안녕|안녕하세요|안뇽|하이|반가워|반갑습니다|hello|hi|hey)[\s!\?~]*$/i.test(lower)) {
            const reply = "안녕하세요! 오늘 운동도 힘차게 시작해 볼까요? 원하시는 루틴이나 무게가 있으시면 편하게 말씀해 주세요!";
            socket.emit('agentChatResponse', { reply, originalMessage: msg });
            return;
        }
        if (/^(?:고마워|감사|감사합니다|고맙습니다|땡큐|thanks)[\s!\?~]*$/i.test(lower)) {
            const reply = "도움이 되어 기쁩니다! 언제든 편하게 말씀해 주세요.";
            socket.emit('agentChatResponse', { reply, originalMessage: msg });
            return;
        }

        // 🚨 1) 바텀 위험(DANGER) 탈출 및 안부 대화 응답 처리
        if (awaitingDangerEscapeConfirm || isDangerActive || currentStatus === 'DANGER') {
            const isEscapeAck = /(괜찮|응|탈출|빠져|나왔|해제|풀어|네|안전|다치지|살았|괜춘|문제없|이상없|멀쩡|벗어|벗어났|살았어|상황\s*벗어|살아남|끝났|완료|ok|yes)/i.test(lower);
            if (isEscapeAck) {
                confirmDangerEscape();
                const reply = "확인되었습니다. 안전 고정을 해제합니다.";
                socket.emit('agentChatResponse', { reply, originalMessage: msg });
                return;
            }
        }

        // 🚨 2) 사용자 위험/긴급 상황 챗 입력 감지 -> 즉시 바 고정 및 안부 확인 발동!
        const isDangerTrigger = /(위험|깔렸|깔림|살려|도와|비상|사고|멈춰|스톱|긴급|살려줘|도와줘|위험해|위험\s*상황)/i.test(lower);
        if (isDangerTrigger) {
            triggerDangerScenario('chat_command', msg);
            const reply = "탈진 위험 감지! 바를 고정했습니다. 괜찮으신가요?";
            socket.emit('agentChatResponse', { reply, originalMessage: msg });
            return;
        }

        // ⚖️ 3) 좌우 불균형 교정 후 본 운동 실시 여부 질문 대화 응답 처리 (또는 불균형 중 해소 요청)
        if (awaitingMainWorkoutConfirm || isImbalanceActive) {
            const isConfirmAck = /(네|응|시작|돌입|그래|좋아|하자|본\s*운동|화이팅|고|해제|맞췄|교정|풀어|원래|yes|ok|start)/i.test(lower);
            if (isConfirmAck) {
                confirmMainWorkout();
                const reply = "원래 무게로 본 운동을 시작합니다.";
                socket.emit('agentChatResponse', { reply, originalMessage: msg });
                return;
            }
        }

        // 🔒 4) 불균형 교정 중 무게 증량 시도 차단
        if (isWeightLocked) {
            const isIncreaseAttempt = /(올려|증가|추가|높여|증량|\+|더해|무겁)/.test(lower);
            if (isIncreaseAttempt) {
                const reply = "불균형 교정 중에는 무게를 올릴 수 없습니다.";
                socket.emit('agentChatResponse', { reply, originalMessage: msg });
                io.emit('agentSpeech', { text: reply });
                return;
            }
        }

        const reply = await chatWithLLM(msg, data.context || {});
        console.log(`[로컬 LLM 챗 답변]: "${reply}"\n`);
        socket.emit('agentChatResponse', { reply: reply, originalMessage: msg });
    });

    // 클라이언트에서 화살표 키 또는 시뮬레이션 버튼으로 입력된 데이터 수신
    socket.on('manualData', (val) => {
        const numVal = parseInt(val, 10);
        if (!isNaN(numVal)) {
            processSensorValue(numVal);
        }
    });

    // 시나리오 1: 바 신체 이탈 토글 (1번 버튼 / 11번 핀 소프트웨어 연동)
    socket.on('toggleBodyDetach', () => {
        toggleBodyDetachment('web_ui');
    });

    // 시나리오 2: 좌우 힘 불균형 토글 (2번 버튼 / 12번 핀 소프트웨어 연동)
    socket.on('toggleImbalance', () => {
        toggleImbalanceScenario('web_ui');
    });

    // 시나리오 2: 본 운동 시작 확인 승인
    socket.on('confirmMainWorkout', () => {
        confirmMainWorkout();
    });

    // 시나리오 3: 긴급 위험 트리거 (클라이언트 챗/버튼 연동)
    socket.on('triggerDanger', (data) => {
        const reason = (data && data.reason) ? data.reason : '사용자 긴급 요청';
        triggerDangerScenario('web_ui', reason);
    });

    // 시나리오 3: 바텀 탈진(DANGER) 탈출 확인 및 안전 고정 해제
    socket.on('confirmDangerEscape', () => {
        confirmDangerEscape();
    });

    // 위험 상태 수동 해제 (기존 버튼 호환)
    socket.on('clearDanger', () => {
        confirmDangerEscape();
    });

    // 목표 반복수 및 권장 휴식 시간 설정 변경
    socket.on('updateSettings', (settings) => {
        if (settings) {
            if (typeof settings.currentSet !== 'undefined') {
                currentSet = Math.max(1, parseInt(settings.currentSet, 10));
                currentSetReps = 0;
            }
            if (settings.targetReps) aiTargetReps = parseInt(settings.targetReps, 10);
            if (settings.targetSets) aiTargetSets = parseInt(settings.targetSets, 10);
            if (settings.restTime) {
                aiRestTimeSeconds = parseInt(settings.restTime, 10);
                isUserCustomRestTime = true;
            }
            console.log(`[설정 변경] 현재 세트: ${currentSet}세트, 목표 반복수: ${aiTargetReps}회, 목표 세트: ${aiTargetSets}세트, 권장 휴식: ${aiRestTimeSeconds}초`);
            io.emit('workoutState', getWorkoutStatePayload());
        }
    });

    // 체중 / 기준 무게 및 부하 설정 변경 (사용자 직접 입력 / AI 음성 명령)
    socket.on('updateWeight', (data) => {
        if (data) {
            if (typeof data.currentSet !== 'undefined') {
                currentSet = Math.max(1, parseInt(data.currentSet, 10));
                currentSetReps = 0;
            }
            const w = typeof data.weightKg !== 'undefined' ? data.weightKg : (typeof data.userWeight !== 'undefined' ? data.userWeight : data.weight);
            if (typeof w !== 'undefined') {
                const targetW = !isNaN(parseFloat(w)) ? parseFloat(w) : 60.0;
                // 불균형 교정 중 증량 차단!
                if (isWeightLocked && targetW > userWeightKg) {
                    console.log(`[증량 차단] 좌우 불균형 교정 진행 중이므로 증량 거부 (${userWeightKg}kg -> ${targetW}kg)`);
                    socket.emit('agentChatResponse', {
                        reply: "현재 좌우 불균형 교정 모드가 진행 중이므로 무게를 올릴 수 없습니다. 올바른 균형으로 동작을 먼저 교정해 주세요.",
                        originalMessage: "무게 증량 시도"
                    });
                    socket.emit('workoutState', getWorkoutStatePayload());
                    return;
                }
                userWeightKg = Math.max(0, Math.min(180, targetW));
                if (userWeightKg > 0) hasUserInteracted = true;
            }
            if (typeof data.assistLevel !== 'undefined') {
                assistLevel = Math.max(0, parseInt(data.assistLevel, 10));
            }
            if (data.targetReps) aiTargetReps = parseInt(data.targetReps, 10);
            if (data.targetSets) aiTargetSets = parseInt(data.targetSets, 10);
            if (data.restTime) {
                aiRestTimeSeconds = parseInt(data.restTime, 10);
                isUserCustomRestTime = true;
            }

            currentSetStartWeightKg = getCurrentLoadKg();
            currentSetStartLevel = assistLevel;

            console.log(`[무게/목표 설정 변경] 현재 세트: ${currentSet}세트, 체중: ${userWeightKg}kg, 부하: Lv.${assistLevel} (${getCurrentLoadKg()}kg), 목표: ${aiTargetReps}회, ${aiTargetSets}세트`);
            io.emit('workoutState', getWorkoutStatePayload());
        }
    });

    // AI 무게 진단 & 추천 Agent 요청 (사용자 운동 패턴 분석 기반)
    socket.on('analyzeWeight', async (data) => {
        const weight = userWeightKg || 70.0;
        let recommendedLoadKg = weight;
        let targetReps = aiTargetReps || 10;
        let restTime = aiRestTimeSeconds || 60;
        let rationale = "";
        let vbtStrategy = "";

        if (setHistory.length === 0) {
            recommendedLoadKg = weight;
            rationale = `아직 완료된 세트 기록이 없습니다. 현재 설정 무게(${weight}kg)로 1세트를 진행하시면 실시간 템포 및 가동범위 패턴을 분석하여 최적 부하를 제안해 드립니다.`;
            vbtStrategy = "기본 템포 및 자세 정렬 확인 단계입니다.";
        } else {
            const lastSet = setHistory[setHistory.length - 1];
            const avgTempo = lastSet.avgTempo || 2.1;
            const hadStall = currentSetAssistTriggers > 0 || (lastSet.loadChanges && lastSet.loadChanges.length > 0);

            if (hadStall || lastSet.reps < Math.max(1, aiTargetReps - 2) || avgTempo >= 3.0) {
                recommendedLoadKg = Math.max(10, Math.round((weight - 5.0) * 10) / 10);
                rationale = `직전 ${lastSet.set}세트 템포(${avgTempo.toFixed(1)}s) 및 피로 누적 패턴 분석 결과, 유효 반복수 완수를 위해 무게 5kg 감량(${recommendedLoadKg}kg)을 제안합니다.`;
                vbtStrategy = "피로 완화 및 유효 볼륨 확보 VBT 전략입니다.";
            } else if (lastSet.reps >= aiTargetReps && avgTempo <= 2.0) {
                recommendedLoadKg = Math.min(150, Math.round((weight + 2.5) * 10) / 10);
                rationale = `직전 ${lastSet.set}세트 평균 템포 ${avgTempo.toFixed(1)}s로 폭발적인 파워가 확인되었습니다. 점진적 과부하를 위해 +2.5kg 증량(${recommendedLoadKg}kg)을 제안합니다.`;
                vbtStrategy = "폭발적 파워 및 근력 강화 VBT 전략입니다.";
            } else {
                recommendedLoadKg = weight;
                rationale = `직전 세트에서 안정적인 페이스(${avgTempo.toFixed(1)}s)를 유지하셨습니다. 현재 무게(${weight}kg) 유지를 제안합니다.`;
                vbtStrategy = "볼륨 및 페이스 유지 전략입니다.";
            }
        }

        socket.emit('weightAnalysisResult', {
            analysis: {
                userWeightKg: weight,
                recommendedLoadKg: recommendedLoadKg,
                assistLevel: 0,
                assistKg: 0,
                targetReps: targetReps,
                restSeconds: restTime,
                rationale: rationale,
                vbtStrategy: vbtStrategy
            }
        });
    });

    // 오늘 운동 기록 초기화 요청 (과거 38일간 가상 일지 및 차트 데이터는 안전하게 보존)
    socket.on('resetWorkout', () => {
        const todayStr = getFormattedDate();
        // 오늘 날짜의 세트만 필터링하여 삭제, 과거 기록은 영구 보존!
        setHistory = (setHistory || []).filter(item => (item.date || todayStr) !== todayStr);

        currentSet = 1;
        currentSetReps = 0;
        totalReps = 0;
        recentTempos = [];
        isResting = false;
        isDangerActive = false;
        awaitingDangerEscapeConfirm = false;
        isBodyDetached = false;
        lockedBarValue = null;
        isImbalanceActive = false;
        isWeightLocked = false;
        preImbalanceWeightKg = null;
        awaitingMainWorkoutConfirm = false;
        lastRepDuration = 0;
        currentStatus = 'WAITING';
        hasUserInteracted = false;
        userWeightKg = 0.0;
        assistLevel = 0;
        lastAssistTimestamp = 0;
        bottomMoveStartTime = 0;
        lastBottomMoveTimestamp = 0;
        bottomStillStartTime = 0;
        midStallStartTime = 0;
        currentSetStartTime = 0;
        currentSetTempos = [];
        currentSetRoms = [];
        currentSetPeaks = [];
        currentSetLoadChanges = [];
        currentSetAssistTriggers = 0;
        currentSetDangerTriggers = 0;
        currentSetStartWeightKg = 0.0;
        currentSetStartLevel = 0;

        if (port && port.isOpen) port.write('N\n');
        console.log(`[오늘(${todayStr}) 운동 기록만 초기화 완료 - 과거 ${setHistory.length}개 세트 영구 보존]`);
        io.emit('workoutState', getWorkoutStatePayload());
        io.emit('sensorData', {
            value: lastValue,
            status: 'WAITING',
            loadKg: getCurrentLoadKg(),
            userWeightKg: userWeightKg,
            decision: "오늘 운동 기록이 초기화되었습니다.\n새로운 세트를 준비해 주세요."
        });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
