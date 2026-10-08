/**
 * workoutHistoryData.js
 * 2026년 9월 1일부터 2026년 10월 8일(오늘)까지의 실감형 AI 운동 일지 데이터 생성 모듈
 * 점진적 과부하(Progressive Overload), 계단식 주기화 적응(Staircase Periodization),
 * 그리고 중간중간 일정/시간 부족 및 피로 누적으로 인한 현실적인 일시적 숏 세션(역성장/단축 루틴) 포함
 */

function formatDurationSec(totalSeconds) {
    const sec = Math.max(0, Math.round(totalSeconds || 0));
    const m = Math.floor(sec / 60);
    const rem = sec % 60;
    if (m > 0) {
        return `${m}분${rem > 0 ? ' ' + rem + '초' : ''}`;
    }
    return `${sec}초`;
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

    // 세트 소요 시간 및 일별 총 운동 시간
    const setDurationSeconds = data.setDurationSeconds || Math.max(15, Math.round(tempos.reduce((a, b) => a + b, 0)));
    const totalDayDurationSeconds = data.workoutDurationSeconds || data.totalDayDurationSeconds || 740;
    const dayDurationFormatted = data.workoutDurationFormatted || data.dayDurationFormatted || formatDurationSec(totalDayDurationSeconds);

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
    const actualRestSec = typeof data.restBeforeSetSeconds === 'number' ? data.restBeforeSetSeconds : (setNum > 1 ? 60 : 0);
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
        time: data.completedAt || '18:15:30',
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
        reason: '중간 정체 7초 감지 (-5.0kg 부하 감소 적용)',
        triggerType: 'mid_stall_7s'
    }] : []);

    const enrichedLoadChanges = rawHistory.map(item => ({
        time: item.time || data.completedAt || '18:15:30',
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
        triggerType: item.triggerType || 'smart_assist'
    }));

    // 4. 세트 종합 소견
    const patternKeyFinding = assistLvl > 0
        ? `R${enrichedLoadChanges[0] ? enrichedLoadChanges[0].repAtTrigger : 7}회 정체 감지로 스마트 어시스트 발동 (-${startLoadKg - finalLoadKg}kg), 목표 랩 안전 완수.`
        : (avgTempo <= 2.0
            ? `평균 템포 ${avgTempo}초 고출력 완수. 완벽 가동범위(PERFECT ROM) 비율 ${Math.round((perfectCount / reps) * 100)}% 달성.`
            : `평균 템포 ${avgTempo}초로 안정적인 수축·이완 리듬 유지. 목표 반복 완수.`);

    return {
        id: `set-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        date: data.date,
        set: setNum,
        reps: reps,
        targetReps: targetReps,
        isCompleted: true,
        startTime: data.startTime || '18:10:00',
        completedAt: data.completedAt || '18:10:30',

        // 운동 시간 관련 핵심 필드
        setDurationSeconds: setDurationSeconds,
        workoutDurationSeconds: totalDayDurationSeconds,
        totalDayDurationSeconds: totalDayDurationSeconds,
        workoutDurationFormatted: dayDurationFormatted,
        dayDurationFormatted: dayDurationFormatted,

        baseWeightKg: baseWeightKg,
        startLoadKg: startLoadKg,
        finalLoadKg: finalLoadKg,
        startIntensityPercent: startIntensityPct,
        finalIntensityPercent: finalIntensityPct,
        loadReductionKg: Math.max(0, Math.round((startLoadKg - finalLoadKg) * 10) / 10),
        assistLevel: assistLvl,
        assistCount: assistLvl > 0 ? enrichedLoadChanges.length : 0,

        totalVolumeKg: totalVolume,
        romRating: perfectCount >= reps * 0.7 ? 'PERFECT' : (perfectCount >= 3 ? 'GOOD' : 'PARTIAL'),
        loadChanges: enrichedLoadChanges,
        loadChangeHistory: enrichedLoadChanges,

        tempoTelemetry: {
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
                    : `높은 속도 일관성 유지 -> 다음 세트 동일 부하 유지 또는 점진적 증량 추천`)
        }
    };
}

/**
 * 2026-09-01부터 2026-10-08(오늘)까지의 일지 데이터 생성기
 * 계단식 주기화 적응 모델(Staircase Adaptation) 및
 * 중간중간 현실적인 시간 부족/피로에 따른 숏 세션(단축 루틴, 템포 일시 지연) 반영
 */
function getDayBlockConfig(dayIdx) {
    // dayIdx: 0 (2026-09-01) ~ 37 (2026-10-08)

    // [역성장 / 시간 부족 숏 세션 1] 9/10 (Day 9, 목): 62.5kg 진행 중 시간 부족으로 2세트(8/7회), 8분 20초 단축
    if (dayIdx === 9) {
        return {
            phaseName: '62.5kg 1차 증량기 (시간 부족 숏 세션)',
            baseWeight: 62.5,
            baseTempo: 2.48, // 피로로 템포 일시 지연
            setCount: 2,
            repsList: [8, 7],
            totalMin: 8.33, // 8분 20초
            restSec: 75,
            assistOnSet3: false,
            isShortSession: true,
            coachFeedback: '일정상 운동 시간이 부족하여 2세트(8회/7회) 단축 루틴으로 진행했습니다. 짧은 시간 내 핵심 유효 자극에 집중했습니다.'
        };
    }

    // [역성장 / 시간 부족 숏 세션 2] 9/17 (Day 16, 목): 65.0kg 진행 중 피로 누적으로 2세트(9/8회), 템포 2.36s, 8분 45초 단축
    if (dayIdx === 16) {
        return {
            phaseName: '65.0kg 2차 증량기 (피로 누적 & 단축 세션)',
            baseWeight: 65.0,
            baseTempo: 2.36, // 전날 대비 템포 살짝 늘어남
            setCount: 2,
            repsList: [9, 8],
            totalMin: 8.75, // 8분 45초
            restSec: 72,
            assistOnSet3: false,
            isShortSession: true,
            coachFeedback: '주중 피로 누적과 시간 제약으로 2세트 단축 완료. 일시적으로 템포가 지연되었으나 부상 없이 안전하게 마쳤습니다.'
        };
    }

    // [역성장 / 시간 부족 숏 세션 3] 9/24 (Day 23, 목): 67.5kg 진행 중 퀵 루틴(2세트 8/7회, 7분 50초)
    if (dayIdx === 23) {
        return {
            phaseName: '67.5kg 3차 증량기 (급한 일정 퀵 루틴)',
            baseWeight: 67.5,
            baseTempo: 2.18, // 템포 살짝 지연
            setCount: 2,
            repsList: [8, 7],
            totalMin: 7.83, // 7분 50초
            restSec: 68,
            assistOnSet3: false,
            isShortSession: true,
            coachFeedback: '시간 부족으로 2세트 퀵 루틴 완료. 짧은 세션이지만 67.5kg 고중량 핵심 수축 자극을 확보했습니다.'
        };
    }

    // [역성장 / 시간 부족 숏 세션 4] 10/2 (Day 31, 금): 70.0kg 진행 중 컨디션 조절형 단축 세션(2세트 8/8회, 8분 15초)
    if (dayIdx === 31) {
        return {
            phaseName: '70.0kg 목표 부하기 (피로 관리형 단축 세션)',
            baseWeight: 70.0,
            baseTempo: 2.08, // 살짝 지연
            setCount: 2,
            repsList: [8, 8],
            totalMin: 8.25, // 8분 15초
            restSec: 65,
            assistOnSet3: false,
            isShortSession: true,
            coachFeedback: '제한된 훈련 시간으로 인해 2세트 집중 루틴 진행. 고중량 피로 누적 구간에서 스마트하게 볼륨을 조절했습니다.'
        };
    }

    // [역성장 / 시간 부족 숏 세션 5] 10/5 (Day 34, 월): 72.5kg 월요 단축 훈련(2세트 9/8회, 8분 30초)
    if (dayIdx === 34) {
        return {
            phaseName: '72.5kg 초과 과부하기 (월요 단축 숏 세션)',
            baseWeight: 72.5,
            baseTempo: 1.94,
            setCount: 2,
            repsList: [9, 8],
            totalMin: 8.50, // 8분 30초
            restSec: 62,
            assistOnSet3: false,
            isShortSession: true,
            coachFeedback: '월요일 일정 제약으로 2세트 고강도 숏 세션 완료. 짧은 시간 내 72.5kg 상위 파워를 유지했습니다.'
        };
    }

    // [블록 1] 60.0kg 적응 (6일간: 9/1 ~ 9/6)
    if (dayIdx <= 5) {
        const step = dayIdx;
        return {
            phaseName: '60.0kg 기초 VBT 리듬 적응기',
            baseWeight: 60.0,
            baseTempo: Number((2.50 - step * 0.03).toFixed(2)), // 2.50s -> 2.35s
            restSec: Math.round(85 - step * 2.0), // 85s -> 75s
            totalMin: Number((18.75 - step * 0.30).toFixed(2)), // 18분 45초 -> 17분 15초
            assistOnSet3: (dayIdx === 0 || dayIdx === 2), // 9/1, 9/3 정체 감량 개입
            coachFeedback: step < 3
                ? '60.0kg 부하 적응 중. 3세트 후반 템포 지연에 맞춰 스마트 감량이 안전하게 개입했습니다.'
                : '60.0kg 완벽 적응! 세트당 평균 템포가 빨라지고 총 운동 시간이 1분 30초 단축되었습니다.'
        };
    }
    // [블록 2] 62.5kg 1차 증량 및 적응 (7일간: 9/7 ~ 9/13)
    else if (dayIdx <= 12) {
        const step = dayIdx - 6;
        return {
            phaseName: '62.5kg 1차 점진적 과부하 증량기',
            baseWeight: 62.5,
            baseTempo: Number((2.42 - step * 0.032).toFixed(2)), // 2.42s -> 2.22s
            restSec: Math.round(80 - step * 2.2), // 80s -> 66s
            totalMin: Number((17.80 - step * 0.30).toFixed(2)), // 17분 48초 -> 15분 55초
            assistOnSet3: (step === 0), // 9/7 증량 첫날만 1회 보조
            coachFeedback: step === 0
                ? '+2.5kg 최초 증량(62.5kg) 도전. 부하 증가에 따라 템포가 일시 조정되었으나 가동범위는 우수합니다.'
                : '62.5kg 부하에 신경근이 완전히 적응했습니다. 동일 3세트 소요 시간이 17분대에서 15분대로 단축되었습니다.'
        };
    }
    // [블록 3] 65.0kg 2차 증량 및 근지구력 확장 (7일간: 9/14 ~ 9/20)
    else if (dayIdx <= 19) {
        const step = dayIdx - 13;
        return {
            phaseName: '65.0kg 2차 증량 및 근지구력 확장기',
            baseWeight: 65.0,
            baseTempo: Number((2.32 - step * 0.035).toFixed(2)), // 2.32s -> 2.11s
            restSec: Math.round(76 - step * 2.0), // 76s -> 64s
            totalMin: Number((16.70 - step * 0.28).toFixed(2)), // 16분 42초 -> 14분 55초
            assistOnSet3: (step === 0), // 9/14 1회
            coachFeedback: step === 0
                ? '65.0kg 진입. 목표 10회 반복을 달성하며 새로운 중량에서 안정적인 수축 리듬을 형성하고 있습니다.'
                : '65.0kg 완벽 소화! 총 운동 시간이 15분 미만으로 단축되었으며 세트 간 빠른 회복력을 보였습니다.'
        };
    }
    // [블록 4] 67.5kg 3차 증량 및 고출력화 (7일간: 9/21 ~ 9/27)
    else if (dayIdx <= 26) {
        const step = dayIdx - 20;
        return {
            phaseName: '67.5kg 3차 증량 및 고출력 VBT 파워화',
            baseWeight: 67.5,
            baseTempo: Number((2.22 - step * 0.038).toFixed(2)), // 2.22s -> 1.99s
            restSec: Math.round(72 - step * 1.8), // 72s -> 61s
            totalMin: Number((15.60 - step * 0.27).toFixed(2)), // 15분 36초 -> 13분 50초
            assistOnSet3: (step === 0), // 9/21 1회
            coachFeedback: step === 0
                ? '67.5kg 고중량 도전기. 템포 손실률 15% 미만으로 근지구력이 견고하게 뒷받침됩니다.'
                : '67.5kg 적응 완료! 평균 템포 1.9초대 진입, 폭발적인 풀업 추진력으로 총 운동 시간을 13분대로 단축했습니다.'
        };
    }
    // [블록 5] 70.0kg 목표 체중 완전 도달 및 고속 수축 (6일간: 9/28 ~ 10/3)
    else if (dayIdx <= 32) {
        const step = dayIdx - 27;
        return {
            phaseName: '70.0kg 목표 체중 완전 도달 및 고속 수축기',
            baseWeight: 70.0,
            baseTempo: Number((2.12 - step * 0.042).toFixed(2)), // 2.12s -> 1.91s
            restSec: Math.round(68 - step * 1.8), // 68s -> 59s
            totalMin: Number((14.50 - step * 0.28).toFixed(2)), // 14분 30초 -> 13분 00초
            assistOnSet3: (step === 0), // 9/28 1회
            coachFeedback: step === 0
                ? '성인 표준 목표 체중 70.0kg 달성! 무보조 10회 풀업을 안정적인 궤적으로 완수했습니다.'
                : '70.0kg 완전 마스터! 초기 60kg 대비 총 운동 시간이 약 6분 단축되었으며 VBT 출력 효율이 정점에 도달했습니다.'
        };
    }
    // [블록 6] 72.5kg 초과 과부하 훈련 (3일간: 10/4 ~ 10/6)
    else if (dayIdx <= 35) {
        const step = dayIdx - 33;
        return {
            phaseName: '72.5kg 초과 과부하 도전기',
            baseWeight: 72.5,
            baseTempo: Number((1.95 - step * 0.045).toFixed(2)), // 1.95s -> 1.86s
            restSec: Math.round(64 - step * 2.0), // 64s -> 60s
            totalMin: Number((13.30 - step * 0.25).toFixed(2)), // 13분 18초 -> 12분 45초
            assistOnSet3: false,
            coachFeedback: '72.5kg 초과 과부하 훈련. 강력한 광배근 수축 속도로 템포 1.8초대를 안정적으로 견인했습니다.'
        };
    }
    // [블록 7] 75.0kg 정점 VBT 파워 신기록 (2일간: 10/7 ~ 10/8 오늘)
    else {
        const step = dayIdx - 36;
        return {
            phaseName: '75.0kg 정점 VBT 파워 신기록 및 마스터',
            baseWeight: 75.0,
            baseTempo: Number((1.88 - step * 0.06).toFixed(2)), // 1.88s -> 1.82s
            restSec: Math.round(60 - step * 3.0), // 60s -> 57s
            totalMin: Number((12.80 - step * 0.45).toFixed(2)), // 12분 48초 -> 12분 21초
            assistOnSet3: false,
            coachFeedback: dayIdx === 37
                ? '오늘 75.0kg 4세트 완벽 완수! 평균 템포 1.82초, 총 운동 시간 12분 21초로 9월 1일(60kg, 18분 45초) 대비 34% 효율 단축 및 역대 최고 VBT 파워 신기록 달성!'
                : '75.0kg 최고 부하 갱신! 템포 1.88초로 고중량-고속 수축 능력을 입증했습니다.'
        };
    }
}

function generateWorkoutHistory() {
    const dates = [];
    // 9월 1일 ~ 9월 30일 (30일)
    for (let d = 1; d <= 30; d++) {
        dates.push(`2026-09-${String(d).padStart(2, '0')}`);
    }
    // 10월 1일 ~ 10월 8일 (8일)
    for (let d = 1; d <= 8; d++) {
        dates.push(`2026-10-${String(d).padStart(2, '0')}`);
    }

    const history = [];

    dates.forEach((dateStr, dayIdx) => {
        const config = getDayBlockConfig(dayIdx);
        const baseWeight = config.baseWeight;
        const baseTempo = config.baseTempo;

        // 요일 계산 (2026-09-01은 화요일)
        const dayOfWeek = (dayIdx + 2) % 7; // 0: 일, 1: 월, ... 6: 토
        const isSunday = (dayOfWeek === 0);

        // 세트 수 결정: 설정에 명시되어 있으면(숏 세션) 우선 적용, 없으면 요일별 기본 규칙
        let setCount = 3;
        if (typeof config.setCount === 'number') {
            setCount = config.setCount;
        } else if (dayIdx === 37) {
            setCount = 4; // 오늘 10월 8일은 최고 집중 4세트
        } else if (isSunday) {
            setCount = 2; // 일요일 가벼운 회복 2세트
        } else if (dayIdx % 3 === 0) {
            setCount = 4;
        }

        // 총 운동 시간(초) 산출
        const totalDurationSec = Math.round(config.totalMin * 60);
        const durationFormatted = formatDurationSec(totalDurationSec);

        const startHour = 18 + (dayIdx % 3); // 18시, 19시, 20시
        let currentMinutes = 10 + (dayIdx % 15);
        let currentSeconds = 20;

        for (let s = 1; s <= setCount; s++) {
            const startStr = `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;

            let reps = 10;
            // 숏 세션의 경우 세트별 랩 수 리스트(repsList) 적용 (예: 8회, 7회 등)
            if (config.repsList && config.repsList[s - 1]) {
                reps = config.repsList[s - 1];
            }

            let assistLvl = 0;
            let startLoadKg = baseWeight;
            let finalLoadKg = baseWeight;
            let startIntensityPct = 100;
            let finalIntensityPct = 100;
            let loadChanges = [];
            let coachFeedback = config.coachFeedback;

            let repTempos = [];

            if (s === 1) {
                if (!config.repsList) reps = 10;
                assistLvl = 0;
                repTempos = Array.from({ length: reps }, (_, i) => Number((baseTempo + i * 0.03).toFixed(1)));
            } else if (s === 2) {
                if (!config.repsList) reps = 10;
                assistLvl = 0;
                repTempos = Array.from({ length: reps }, (_, i) => Number((baseTempo + 0.05 + i * 0.04).toFixed(1)));
            } else if (s === 3) {
                if (config.assistOnSet3 && !isSunday) {
                    reps = 9;
                    assistLvl = 1;
                    finalLoadKg = Math.max(10, Math.round((baseWeight - 5.0) * 10) / 10);
                    finalIntensityPct = 85;
                    loadChanges = [{
                        time: `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds + 18).padStart(2, '0')}`,
                        fromKg: baseWeight,
                        toKg: finalLoadKg,
                        fromPercent: 100,
                        toPercent: 85,
                        reason: '7회차 정체 감지 (-5.0kg 부하 감소)',
                        repAtTrigger: 7,
                        heightPct: 52
                    }];
                    repTempos = Array.from({ length: 9 }, (_, i) => Number((baseTempo + 0.12 + (i >= 7 ? -0.08 : i * 0.06)).toFixed(1)));
                } else {
                    reps = (dayIdx > 20) ? 10 : 9;
                    assistLvl = 0;
                    repTempos = Array.from({ length: reps }, (_, i) => Number((baseTempo + 0.08 + i * 0.05).toFixed(1)));
                }
            } else if (s === 4) {
                reps = (dayIdx === 37) ? 10 : (dayIdx > 25 ? 9 : 8);
                assistLvl = 0;
                repTempos = Array.from({ length: reps }, (_, i) => Number((baseTempo + 0.10 + i * 0.05).toFixed(1)));
            }

            const setDurationSec = Math.max(15, Math.round(repTempos.reduce((a, b) => a + b, 0)));

            // 시계 진행 (세트 소요 시간만큼 경과)
            currentSeconds += setDurationSec;
            while (currentSeconds >= 60) {
                currentMinutes += 1;
                currentSeconds -= 60;
            }
            const completeStr = `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;

            // 세트 간 휴식 시간 경과
            const restSecThisSet = s === 1 ? 0 : config.restSec;
            currentSeconds += restSecThisSet;
            while (currentSeconds >= 60) {
                currentMinutes += 1;
                currentSeconds -= 60;
            }

            const rec = createDetailedSetRecord({
                date: dateStr,
                set: s,
                reps: reps,
                targetReps: 10,
                baseWeightKg: baseWeight,
                startLoadKg: startLoadKg,
                finalLoadKg: finalLoadKg,
                startIntensityPercent: startIntensityPct,
                finalIntensityPercent: finalIntensityPct,
                assistLevel: assistLvl,
                loadChangeHistory: loadChanges,
                repTempos: repTempos,
                completedAt: completeStr,
                startTime: startStr,
                setDurationSeconds: setDurationSec,
                workoutDurationSeconds: totalDurationSec,
                totalDayDurationSeconds: totalDurationSec,
                workoutDurationFormatted: durationFormatted,
                dayDurationFormatted: durationFormatted,
                restBeforeSetSeconds: restSecThisSet,
                coachFeedbackSnippet: coachFeedback
            });

            history.push(rec);
        }
    });

    return history;
}

const initialSetHistory = generateWorkoutHistory();

module.exports = {
    formatDurationSec,
    createDetailedSetRecord,
    generateWorkoutHistory,
    initialSetHistory
};
