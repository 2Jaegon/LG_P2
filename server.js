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
let isDangerActive = false;    // 위험 감지 및 안전 리프트 상태 플래그 (절대 휴식으로 자동 전환되지 않음)
let assistLevel = 0; // 부하 감소 단계 (0: 정상, 1: 1차 감소, 2: 2차 감소...)
let lastAssistTimestamp = 0; // 마지막 부하 감소 적용 시각 (3초 후 추가 감소용)
let bottomMoveStartTime = 0; // 바텀 범위 내에서 꼼질꼼질 움직인 시작 시각 (7초 후 DANGER)
let bottomStillStartTime = 0; // 바텀 범위 내에서 완전히 정지한 시작 시각 (7초 후 REST/세트완료)
let midStallStartTime = 0;    // 바텀-탑 중간 구간 정체 시작 시각 (7초 후 ASSIST)

// =================== AI 에이전트 동적 제어 변수 ===================
let aiTargetReps = 10;
let aiTargetSets = 5;
let aiRestTimeSeconds = 60;

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

let userWeightKg = 70.0; // 사용자가 설정한 기준 무게 / 체중 (Kg)
let currentSetStartTime = 0;
let currentSetStartWeightKg = 70.0;
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
    if (typeof weightKg === 'number' && weightKg > 0) return weightKg;
    return userWeightKg;
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

let setHistory = [
    createDetailedSetRecord({
        date: '2026-10-04', set: 1, reps: 10, targetReps: 10, baseWeightKg: 70.0, assistLevel: 0,
        repTempos: [2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.3, 2.4, 2.5, 2.6],
        completedAt: '18:15:20', startTime: '18:14:55',
        coachFeedbackSnippet: "첫 세트 가동범위와 템포가 매우 균일하고 안정적이었습니다."
    }),
    createDetailedSetRecord({
        date: '2026-10-04', set: 2, reps: 9, targetReps: 10, baseWeightKg: 70.0, assistLevel: 1,
        startLoadKg: 70.0, finalLoadKg: 59.5, startIntensityPercent: 100, finalIntensityPercent: 85,
        loadChangeHistory: [{ time: '18:18:25', fromKg: 70.0, toKg: 59.5, fromPercent: 100, toPercent: 85, reason: '7회차 정체 7초 감지 (-15% 부하 감소 적용)' }],
        repTempos: [2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.4, 2.5],
        completedAt: '18:18:45', startTime: '18:18:20', restBeforeSetSeconds: 62,
        coachFeedbackSnippet: "무게 부담 감지 시 스마트 어시스트가 신속히 개입하여 목표 반복을 거의 채웠습니다."
    }),
    createDetailedSetRecord({
        date: '2026-10-04', set: 3, reps: 8, targetReps: 10, baseWeightKg: 70.0, assistLevel: 1,
        startLoadKg: 59.5, finalLoadKg: 59.5, startIntensityPercent: 85, finalIntensityPercent: 85,
        repTempos: [2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.0, 3.2],
        completedAt: '18:22:10', startTime: '18:21:45', restBeforeSetSeconds: 65,
        coachFeedbackSnippet: "누적 피로 속에서도 감경된 부하를 유지하며 끝까지 집중했습니다."
    }),
    createDetailedSetRecord({
        date: '2026-10-05', set: 1, reps: 10, targetReps: 10, baseWeightKg: 70.0, assistLevel: 0,
        repTempos: [1.9, 2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.3, 2.3, 2.4],
        completedAt: '19:05:12', startTime: '19:04:48',
        coachFeedbackSnippet: "최상의 컨디션으로 빠른 템포와 완벽한 ROM을 유지했습니다."
    }),
    createDetailedSetRecord({
        date: '2026-10-05', set: 2, reps: 10, targetReps: 10, baseWeightKg: 70.0, assistLevel: 0,
        repTempos: [2.0, 2.1, 2.1, 2.2, 2.3, 2.3, 2.4, 2.5, 2.6, 2.7],
        completedAt: '19:08:40', startTime: '19:08:15', restBeforeSetSeconds: 60,
        coachFeedbackSnippet: "2세트 연속 10회 완수 달성!"
    }),
    createDetailedSetRecord({
        date: '2026-10-05', set: 3, reps: 9, targetReps: 10, baseWeightKg: 70.0, assistLevel: 1,
        startLoadKg: 70.0, finalLoadKg: 59.5, startIntensityPercent: 100, finalIntensityPercent: 85,
        loadChangeHistory: [{ time: '19:12:00', fromKg: 70.0, toKg: 59.5, fromPercent: 100, toPercent: 85, reason: '중간 정체 7초 감지 (-15% 부하 감소)' }],
        repTempos: [2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.5, 2.6],
        completedAt: '19:12:15', startTime: '19:11:50', restBeforeSetSeconds: 58
    }),
    createDetailedSetRecord({
        date: '2026-10-05', set: 4, reps: 8, targetReps: 10, baseWeightKg: 70.0, assistLevel: 2,
        startLoadKg: 59.5, finalLoadKg: 49.0, startIntensityPercent: 85, finalIntensityPercent: 70,
        loadChangeHistory: [{ time: '19:15:45', fromKg: 59.5, toKg: 49.0, fromPercent: 85, toPercent: 70, reason: '추가 정체 3초 감지 (-30% 부하 감소)' }],
        repTempos: [2.4, 2.5, 2.6, 2.7, 2.8, 2.8, 2.6, 2.7],
        completedAt: '19:16:02', startTime: '19:15:35', restBeforeSetSeconds: 70
    })
];

let isResting = false;
let restStartTime = 0;

const THRESHOLD_BOTTOM = 280; // 하단 기준 (시작/완료)
const THRESHOLD_TOP = 740;    // 상단 최고점 기준

// =================== 실시간 안전 및 모션 타이밍 임계치 (단위: ms) ===================
let DANGER_TRIGGER_MS = 2000;      // 바텀 탈진 꼼질거림 위험 감지 시간: 2.0초
let MID_STALL_TRIGGER_MS = 5000;   // 바텀-탑 중간 정체 부하감소(ASSIST) 시간: 5.0초 (너무 빠른 발동 방지)
let CONT_STALL_TRIGGER_MS = 4000;  // 정체 지속 시 추가 감경 간격: 4.0초
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

// 상-하 연속 움직임 감지(Repetition) 및 자동 세트/휴식 판별 알고리즘
function trackRepetition(value) {
    const now = Date.now();

    // 1. Rep 상태 머신 (FSM)
    if (repStage === 'WAITING_START') {
        if (value > THRESHOLD_BOTTOM + 80) { // 360 이상으로 당기기 시작
            repStage = 'GOING_UP';
            repStartTime = now;
            peakValue = value;
            bottomMoveStartTime = 0;
            bottomStillStartTime = 0;

            if (currentSetStartTime === 0) {
                currentSetStartTime = now;
                if (restStartTime > 0) {
                    lastSetRestDurationSec = Math.floor((now - restStartTime) / 1000);
                }
            }

            // 위험 상태였던 경우, 사용자가 힘차게 다시 당겨 올리면 위험 해제 및 운동 재개!
            if (currentStatus === 'DANGER' || isDangerActive) {
                currentStatus = 'NORMAL';
                isDangerActive = false;
                console.log(`\n[위험 해제 및 운동 재개] 사용자가 바를 다시 당겨 올림 -> NORMAL 정상 복구`);
                if (port && port.isOpen) port.write('N\n');
                io.emit('sensorData', {
                    value: value,
                    status: 'NORMAL',
                    decision: "안전 조치 해제: 운동을 다시 시작합니다!\n자세를 바르게 유지하며 힘차게 당겨주세요!"
                });
            }

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
                lastAssistTimestamp = 0;
                console.log(`\n[TOP 달성] 상단 도달 -> 무게 부담(ASSIST) 상태 해제 (부하 감소 강도 Lv.${assistLevel} 유지)`);
                if (port && port.isOpen) port.write('N\n');
                io.emit('sensorData', {
                    value: value,
                    status: 'NORMAL',
                    assistLevel: assistLevel,
                    decision: `TOP 도달 성공!\n감소된 부하(Lv.${assistLevel})를 유지하며 하강하세요!`
                });
            }
        } else if (value <= THRESHOLD_BOTTOM) {
            // 충분히 오르지 못하고 바로 내려온 경우 초기화
            repStage = 'WAITING_START';
            midStallStartTime = 0;
            if (currentStatus === 'ASSIST') {
                currentStatus = 'NORMAL';
                lastAssistTimestamp = 0;
                assistLevel = 0;
                console.log(`\n[바텀 복귀] 바텀 도달로 인해 무게 부담(ASSIST) 상태 해제 -> NORMAL`);
                if (port && port.isOpen) port.write('N\n');
                io.emit('sensorData', {
                    value: value,
                    status: 'NORMAL',
                    assistLevel: 0,
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
                    if (port && port.isOpen) port.write('N\n');
                }

                console.log(`[Rep 달성] Set ${currentSet} - ${currentSetReps}회 완료! (템포: ${durationSec.toFixed(1)}s, ROM: ${romRatingVal}, 부하: ${getCurrentLoadKg()}kg [Lv.${assistLevel}])`);

                io.emit('repCompleted', {
                    currentSet,
                    reps: currentSetReps,
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
    const now = Date.now();

    sensorDataBuffer.push(value);
    if (sensorDataBuffer.length > 50) sensorDataBuffer.shift();
    lastValue = value;
    
    // 빠른 움직임 감지용 버퍼 유지 (최근 데이터 최대 15개, 약 1.5초)
    recentDataBuffer.push(value);
    if (recentDataBuffer.length > 15) recentDataBuffer.shift();

    // 초기값 대비 움직임이 발생하면 사용자가 운동을 개시한 것으로 간주
    if (!hasUserInteracted && (value > THRESHOLD_BOTTOM + 80 || currentSetReps > 0 || totalReps > 0)) {
        hasUserInteracted = true;
    }

    // 운동량(반복수 및 세트) 실시간 추적
    trackRepetition(value);

    // 최근 1~1.5초간의 변동폭 측정 (움직임 여부 판별)
    const rMax = Math.max(...recentDataBuffer);
    const rMin = Math.min(...recentDataBuffer);
    const recentDiff = rMax - rMin;

    const BOTTOM_ZONE_LIMIT = THRESHOLD_BOTTOM + 100; // 380 이하를 바텀 구간으로 판별

    // =========================================================================
    // [구간 1] 바텀 구간 (<= 380) 체류 시 판정: 완전 정지(휴식) vs 꼼질꼼질 움직임(탈진 위험)
    // =========================================================================
    if (value <= BOTTOM_ZONE_LIMIT) {
        midStallStartTime = 0; // 중간 정체 타이머 리셋

        // ⭐️ 바텀 구간(또는 바텀 아래)에 위치할 때는 무게 부담(ASSIST) 상태를 즉시 NORMAL로 자동 해제!
        if (currentStatus === 'ASSIST') {
            currentStatus = 'NORMAL';
            lastAssistTimestamp = 0;
            assistLevel = 0;
            console.log(`\n[바텀 구간 진입] 바텀 위치(현재값: ${value} <= ${BOTTOM_ZONE_LIMIT})에 머물고 있으므로 무게 부담(ASSIST) 상태 해제 -> NORMAL 복구`);
            if (port && port.isOpen) {
                port.write('N\n');
            }
            io.emit('sensorData', {
                value: value,
                status: 'NORMAL',
                assistLevel: 0,
                loadKg: userWeightKg,
                userWeightKg: userWeightKg,
                decision: "바텀 위치입니다.\n호흡을 가다듬고 준비되시면 다시 당겨주세요."
            });
            io.emit('workoutState', getWorkoutStatePayload());
        }

        // 1-A. 바텀 범위 내에서 꼼질꼼질 움직임 (recentDiff > 15) -> 탈진 위험 (DANGER)!
        if (recentDiff > 15) {
            bottomStillStartTime = 0; // 정지 타이머 리셋
            if (bottomMoveStartTime === 0) {
                bottomMoveStartTime = now;
            }

            const movingDuration = now - bottomMoveStartTime;
            if (movingDuration >= DANGER_TRIGGER_MS) {
                if (currentStatus !== 'DANGER') {
                    currentStatus = 'DANGER';
                    isDangerActive = true;
                    assistLevel = 0;
                    lastAssistTimestamp = 0;
                    if (isResting) isResting = false; // 휴식 중이었더라도 위험 상황으로 즉각 전환

                    console.log(`\n[위험 즉각 감지] 바텀 범위 내 탈진 꼼질거림 감지 -> 위험 (DANGER)! (경과: ${(movingDuration / 1000).toFixed(1)}초, 최근변동폭: ${recentDiff})`);
                    if (port && port.isOpen) {
                        port.write('H\n');
                    }
                    io.emit('sensorData', {
                        value: value,
                        status: 'DANGER',
                        decision: "경고: 한계 도달 (바텀 탈진 감지)!\n안전 리프트가 바를 Bottom 라인으로 올립니다.\n무리하지 말고 안전하게 내려오세요."
                    });
                    io.emit('workoutState', getWorkoutStatePayload());
                }
            }
        } 
        // 1-B. 바텀에서 딱 같은 값으로 완전히 정지 (recentDiff <= 15)
        else {
            bottomMoveStartTime = 0; // 움직임 타이머 리셋

            // 🚨 위험(DANGER) 감지 상태이거나 안전 리프트로 바가 올려진 상태일 때:
            // 절대 '휴식'이나 '세트 완료'로 전환되지 않음! 비상 안전 정지 상태 유지!
            if (currentStatus === 'DANGER' || isDangerActive) {
                bottomStillStartTime = 0; // 휴식 판정 카운트 차단
                return;
            }

            // [정상 운동 시에만] 손을 놓고 내려와 쉬는 상태 (휴식 및 세트 종료)
            if (bottomStillStartTime === 0) {
                bottomStillStartTime = now;
            }

            const stillDuration = now - bottomStillStartTime;
            if (stillDuration >= SET_COMPLETE_STILL_MS) {
                // 세트 진행 중(1회 이상 성공)이었다면 자동으로 세트 완료 처리 및 휴식 타이머 시작
                if (currentSetReps >= 1 && !isResting && repStage === 'WAITING_START') {
                    completeCurrentSet(now);
                }
            }
        }
    } 
    // =========================================================================
    // [구간 2] 바텀 구간 탈출 (> 380) 시
    // =========================================================================
    else {
        bottomMoveStartTime = 0;
        bottomStillStartTime = 0;

        // DANGER 상태에서 사용자가 힘을 내서 위로 당겨 올라왔다면 즉시 정상 복귀!
        if (currentStatus === 'DANGER' || isDangerActive) {
            currentStatus = 'NORMAL';
            isDangerActive = false;
            console.log(`\n[위험 탈출 감지] 바텀 구간 탈출 상승 (현재값: ${value}) -> NORMAL 정상 복구`);
            if (port && port.isOpen) {
                port.write('N\n');
            }
            io.emit('sensorData', {
                value: value,
                status: 'NORMAL',
                decision: "위험 구간을 탈출했습니다!\n페이스를 유지하며 당겨주세요!"
            });
        }

        // ⭐️ 바텀과 탑 사이 중간 정체 판별 -> 사용자 무게 부담 (ASSIST)
        // 조건:
        // 1. 반드시 당겨 올라가는 중(repStage === 'GOING_UP')이어야 함 (대기 중이거나 하강 중에는 발동 금지)
        // 2. 바텀(280)을 확실히 벗어난 중상단 구간 (value >= THRESHOLD_BOTTOM + 120 = 400 이상)
        // 3. 탑(740) 도달 직전 미만 (value < THRESHOLD_TOP - 40 = 700 미만)
        // 4. 휴식 상태가 아님
        const isMidAscentStallZone = (repStage === 'GOING_UP') && (value >= THRESHOLD_BOTTOM + 120) && (value < THRESHOLD_TOP - 40) && !isResting;

        if (isMidAscentStallZone) {
            // 실제 정체 상태: 움직임이 거의 정지된 호버링 상태 (recentDiff < 60)
            if (recentDiff < 60) {
                if (midStallStartTime === 0) {
                    midStallStartTime = now;
                }

                if (now - midStallStartTime >= MID_STALL_TRIGGER_MS) {
                    // 최초 정체 시 무게 5kg 직접 감소 적용
                    if (assistLevel === 0) {
                        const prevKg = userWeightKg;
                        userWeightKg = Math.max(10, Math.round((userWeightKg - 5.0) * 10) / 10);
                        const nextKg = userWeightKg;
                        const hPct = Math.round((value / 1023) * 100);
                        currentSetLoadChanges.push({
                            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                            set: currentSet,
                            repAtTrigger: currentSetReps + 1,
                            totalRepsAtTrigger: totalReps + 1,
                            heightPct: hPct,
                            fromKg: prevKg,
                            toKg: nextKg,
                            reductionKg: Math.round((prevKg - nextKg) * 10) / 10,
                            fromPercent: 100,
                            toPercent: Math.round((nextKg / prevKg) * 100),
                            reductionPercent: 100 - Math.round((nextKg / prevKg) * 100),
                            reason: `중간 정체 ${(MID_STALL_TRIGGER_MS / 1000).toFixed(1)}초 감지 (무게 5kg 직접 감소)`,
                            triggerType: 'mid_stall_direct_weight'
                        });
                        currentSetAssistTriggers++;
                        lastAssistTimestamp = now;
                        currentStatus = 'ASSIST';
                        assistLevel = 1;
                        console.log(`\n[중간 정체 감지] Set ${currentSet} ${currentSetReps + 1}회차 도중(높이 ${hPct}%) 정체 -> 무게 5kg 감소: ${prevKg}kg -> ${nextKg}kg`);
                        if (port && port.isOpen) {
                            port.write('L\n');
                        }
                        io.emit('sensorData', {
                            value: value,
                            status: 'ASSIST',
                            assistLevel: 1,
                            loadKg: nextKg,
                            userWeightKg: nextKg,
                            decision: `정체 감지! 부담을 덜기 위해 무게를 5kg 줄였습니다 (${nextKg}kg).\n호흡을 가다듬고 당겨보세요!`
                        });
                        io.emit('workoutState', getWorkoutStatePayload());
                    } 
                    // 감량 후에도 CONT_STALL_TRIGGER_MS 간 진전이 없으면 또 5kg 감소!
                    else if (currentStatus === 'ASSIST' && now - lastAssistTimestamp >= CONT_STALL_TRIGGER_MS) {
                        const prevKg = userWeightKg;
                        userWeightKg = Math.max(10, Math.round((userWeightKg - 5.0) * 10) / 10);
                        const nextKg = userWeightKg;
                        assistLevel++;
                        const hPct = Math.round((value / 1023) * 100);
                        currentSetLoadChanges.push({
                            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                            set: currentSet,
                            repAtTrigger: currentSetReps + 1,
                            totalRepsAtTrigger: totalReps + 1,
                            heightPct: hPct,
                            fromKg: prevKg,
                            toKg: nextKg,
                            reductionKg: Math.round((prevKg - nextKg) * 10) / 10,
                            fromPercent: 100,
                            toPercent: Math.round((nextKg / prevKg) * 100),
                            reductionPercent: 100 - Math.round((nextKg / prevKg) * 100),
                            reason: `정체 ${(CONT_STALL_TRIGGER_MS / 1000).toFixed(1)}초 지속 감지 (무게 추가 5kg 감소)`,
                            triggerType: 'stall_continuous'
                        });
                        currentSetAssistTriggers++;
                        lastAssistTimestamp = now;
                        console.log(`\n[정체 지속] 진전 없음 -> 무게 추가 5kg 감소: ${prevKg}kg -> ${nextKg}kg`);
                        if (port && port.isOpen) {
                            port.write('L\n');
                        }
                        io.emit('sensorData', {
                            value: value,
                            status: 'ASSIST',
                            assistLevel: assistLevel,
                            loadKg: nextKg,
                            userWeightKg: nextKg,
                            decision: `정체가 지속되어 무게를 추가로 5kg 줄였습니다 (${nextKg}kg)!\n끝까지 힘을 내세요!`
                        });
                        io.emit('workoutState', getWorkoutStatePayload());
                    }
                }
            } 
            // 움직임이 있을 때는 정체 타이머만 리셋 (ASSIST 상태 해제는 TOP 도달 시에만 수행)
            else {
                midStallStartTime = 0;
            }
        } else {
            midStallStartTime = 0;
            // TOP 도달 시 감량된 무게 유지하며 정상 상태 복귀
            if (currentStatus === 'ASSIST' && value >= THRESHOLD_TOP) {
                currentStatus = 'NORMAL';
                lastAssistTimestamp = 0;
                assistLevel = 0;
                console.log(`\n[TOP 달성] 상단 도달 -> 무게 감량(${userWeightKg}kg) 유지`);
                if (port && port.isOpen) port.write('N\n');
                io.emit('sensorData', {
                    value: value,
                    status: 'NORMAL',
                    assistLevel: 0,
                    loadKg: userWeightKg,
                    userWeightKg: userWeightKg,
                    decision: `TOP 도달 성공!\n줄어든 무게(${userWeightKg}kg)로 페이스를 이어가세요!`
                });
                io.emit('workoutState', getWorkoutStatePayload());
            }
        }
    }

    // 센서 값은 실시간으로 웹에 표시
    io.emit('sensorData', {
        value: value,
        assistLevel: assistLevel
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

            // 아두이노에서 데이터 수신
            parser.on('data', (data) => {
                const value = parseInt(data.trim(), 10);
                if (!isNaN(value)) {
                    processSensorValue(value);
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
- 상태가 "ASSIST"인 경우: 바텀과 탑 사이에서 무게 부담으로 인해 정체된 상태입니다. "무게 부담 감지!\\n스마트 어시스트가 부하를 감소시킵니다.\\n호흡을 가다듬고 끝까지 힘을 내세요!" 형태로 부하 감소 안내 멘트를 작성하세요.
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
  "nextTargetReps": 10,
  "restTimeSeconds": 60
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
        if (llmReply.restTimeSeconds && !isNaN(llmReply.restTimeSeconds)) {
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
                llmReply.action = "무게 부담 감지!\n스마트 어시스트가 작동하여 부하를 즉시 감소시킵니다.";
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

io.on('connection', (socket) => {
    console.log('A web client connected.');

    // 클라이언트 접속 시 현재까지의 운동 상태(세트, 횟수, 히스토리 등) 및 하드웨어 연결 상태 즉시 전송
    socket.emit('workoutState', getWorkoutStatePayload());
    socket.emit('arduinoStatus', { connected: Boolean(port && port.isOpen), port: activePortPath });

    // 클라이언트에서 화살표 키 또는 시뮬레이션 버튼으로 입력된 데이터 수신
    socket.on('manualData', (val) => {
        const numVal = parseInt(val, 10);
        if (!isNaN(numVal)) {
            processSensorValue(numVal);
        }
    });

    // 위험 상태 수동 해제 (안전 확인 후 정상 복귀)
    socket.on('clearDanger', () => {
        isDangerActive = false;
        if (currentStatus === 'DANGER') {
            currentStatus = 'NORMAL';
            if (port && port.isOpen) port.write('N\n');
            console.log('[위험 상태 수동 해제됨]');
            io.emit('sensorData', {
                value: lastValue,
                status: 'NORMAL',
                decision: "위험 상태가 해제되었습니다.\n자세를 가다듬고 바를 당겨 운동을 재개하세요."
            });
            io.emit('workoutState', getWorkoutStatePayload());
        }
    });

    // 목표 반복수 및 권장 휴식 시간 설정 변경
    socket.on('updateSettings', (settings) => {
        if (settings) {
            if (settings.targetReps) aiTargetReps = parseInt(settings.targetReps, 10);
            if (settings.targetSets) aiTargetSets = parseInt(settings.targetSets, 10);
            if (settings.restTime) aiRestTimeSeconds = parseInt(settings.restTime, 10);
            console.log(`[설정 변경] 목표 반복수: ${aiTargetReps}회, 목표 세트: ${aiTargetSets}세트, 권장 휴식: ${aiRestTimeSeconds}초`);
            io.emit('workoutState', getWorkoutStatePayload());
        }
    });

    // 체중 / 기준 무게 및 부하 설정 변경 (사용자 직접 입력 / AI 음성 명령)
    socket.on('updateWeight', (data) => {
        if (data) {
            const w = typeof data.weightKg !== 'undefined' ? data.weightKg : (typeof data.userWeight !== 'undefined' ? data.userWeight : data.weight);
            if (typeof w !== 'undefined') {
                userWeightKg = Math.max(10, Math.min(180, parseFloat(w) || 70.0));
            }
            if (typeof data.assistLevel !== 'undefined') {
                assistLevel = Math.max(0, parseInt(data.assistLevel, 10));
            }
            if (data.targetReps) aiTargetReps = parseInt(data.targetReps, 10);
            if (data.targetSets) aiTargetSets = parseInt(data.targetSets, 10);
            if (data.restTime) aiRestTimeSeconds = parseInt(data.restTime, 10);

            currentSetStartWeightKg = getCurrentLoadKg();
            currentSetStartLevel = assistLevel;

            console.log(`[무게/목표 설정 변경] 체중: ${userWeightKg}kg, 부하: Lv.${assistLevel} (${getCurrentLoadKg()}kg), 목표: ${aiTargetReps}회, ${aiTargetSets}세트`);
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

    // 운동 기록 초기화 요청
    socket.on('resetWorkout', () => {
        currentSet = 1;
        currentSetReps = 0;
        totalReps = 0;
        recentTempos = [];
        setHistory = [];
        isResting = false;
        isDangerActive = false;
        lastRepDuration = 0;
        currentStatus = 'WAITING';
        assistLevel = 0;
        lastAssistTimestamp = 0;
        bottomMoveStartTime = 0;
        bottomStillStartTime = 0;
        midStallStartTime = 0;
        currentSetStartTime = 0;
        currentSetTempos = [];
        currentSetRoms = [];
        currentSetPeaks = [];
        currentSetLoadChanges = [];
        currentSetAssistTriggers = 0;
        currentSetDangerTriggers = 0;
        currentSetStartWeightKg = userWeightKg;
        currentSetStartLevel = 0;

        if (port && port.isOpen) port.write('N\n');
        console.log('[운동 기록 초기화됨]');
        io.emit('workoutState', getWorkoutStatePayload());
        io.emit('sensorData', {
            value: lastValue,
            status: 'WAITING',
            loadKg: getCurrentLoadKg(),
            userWeightKg: userWeightKg,
            decision: "운동 준비 완료.\n풀업 바를 끝까지 당겨 1회를 시작하세요."
        });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
