/**
 * workoutHistoryData.js
 * 2026년 9월 1일부터 2026년 10월 8일(오늘)까지의 실감형 AI 운동 일지 데이터 생성 모듈
 * 점진적 과부하(Progressive Overload), 계단식 주기화 적응(Staircase Periodization),
 * 그리고 중간중간 일정/시간 부족 및 피로 누적으로 인한 현실적인 일시적 숏 세션(역성장/단축 루틴) 포함
 */

function formatDurationSec(totalSeconds) {
    const sec = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const rem = sec % 60;
    if (h > 0) {
        return `${h}시간 ${m}분${rem > 0 ? ' ' + rem + '초' : ''}`;
    }
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

    // 4. 세트 종합 소견 (워밍업 vs 본 세트 구분, 본 세트는 드랍 형식 포함)
    const isWarmup = data.setType === 'WARMUP';
    const setType = isWarmup ? 'WARMUP' : 'MAIN';
    const setTypeLabel = isWarmup ? '워밍업' : '본 세트';

    let patternKeyFinding = '';
    if (isWarmup) {
        patternKeyFinding = `[워밍업] 가벼운 부하(${startLoadKg}kg)로 ${reps}회 고반복 예열을 수행하여 관절 윤활액 분비 및 광배근 신경계 활성화 완료.`;
    } else if (assistLvl > 0 && enrichedLoadChanges.length > 0) {
        const ev = enrichedLoadChanges[0];
        patternKeyFinding = `R${ev.repAtTrigger}회 정체 감지로 스마트 보조 발동(-${ev.reductionKg}kg, 높이 ${ev.heightPct}%), ${ev.toKg}kg로 목표 반복 안전 완수.`;
    } else {
        const isDroppedLoad = (data.isDroppedLoad || startLoadKg < (data.baseWeightKg || 70));
        if (isDroppedLoad) {
            patternKeyFinding = `[본 세트] 부하 10kg 감량(${startLoadKg}kg) 드랍 방식으로 ${reps}회 완수. 지근·속근 섬유 고강도 볼륨 자극 확보.`;
        } else {
            patternKeyFinding = avgTempo <= 2.0
                ? `[본 세트] 최고 부하 ${startLoadKg}kg 탑 세트를 평균 템포 ${avgTempo}초 고출력으로 완수. 완벽 가동범위 달성.`
                : `[본 세트] 최고 부하 ${startLoadKg}kg 탑 세트에서 안정적인 수축·이완 리듬 유지. 목표 반복 완수.`;
        }
    }

    return {
        id: `set-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        date: data.date,
        set: setNum,
        setType: setType,
        setTypeLabel: setTypeLabel,
        isWarmup: isWarmup,
        isDropSet: false,
        reps: reps,
        targetReps: targetReps,
        isCompleted: true,
        startTime: data.startTime || '18:10:00',
        completedAt: data.completedAt || '18:10:30',

        // 운동 시간 및 사용자 가용 시간 버짓(Time Budget) 메타데이터
        setDurationSeconds: setDurationSeconds,
        workoutDurationSeconds: totalDayDurationSeconds,
        totalDayDurationSeconds: totalDayDurationSeconds,
        workoutDurationFormatted: dayDurationFormatted,
        dayDurationFormatted: dayDurationFormatted,
        timeBudget: data.timeBudget || 'UNDER_60M',
        timeBudgetLabel: data.timeBudgetLabel || '1시간 미만 일반 세션',
        targetDurationMin: data.targetDurationMin || 45,

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

/**
 * 사용자 가용 시간 버짓 (Time Budget) 판별기
 * 추후 사용자가 입력할 수 있는 가용 시간에 맞춰 세트 수와 루틴을 추천하기 위한 사전 텔레메트리 기반
 * 1. UNDER_30M (30분 미만): 바쁜 일정 퀵 숏세션 -> 워밍업 1 + 본 세트 1~2 (총 2~3세트, 18~24분 소요)
 * 2. UNDER_60M (1시간 미만): 평일 표준 정규 세션 -> 워밍업 1 + 본 세트 3~4 (총 4~5세트, 38~45분 소요)
 * 3. OVER_60M (1시간 이상): 주말 및 고강도 풀볼륨 세션 -> 워밍업 1 + 본 세트 6 (총 7세트, 64~70분 소요)
 */
function getTimeBudgetTier(dayIdx) {
    // [1시간 이상 집중 풀볼륨]: 주말 토요일(9/5, 9/12, 9/19, 9/26, 10/3), 특별 집중일(9/20), 오늘(10/8)
    const over60Days = [4, 11, 18, 19, 25, 32, 37];
    if (over60Days.includes(dayIdx)) {
        return {
            tier: 'OVER_60M',
            label: '1시간 이상',
            mainSets: 6, // 워밍업 1 + 본 세트 6 = 총 7세트
            targetMin: 64 + (dayIdx % 7), // 64 ~ 70분
            restSec: 85
        };
    }

    // [30분 미만 퀵 숏세션]: 바쁜 목요일, 일요 가벼운 회복, 일정 제약일
    const under30Days = [2, 5, 9, 12, 16, 23, 31, 34];
    if (under30Days.includes(dayIdx)) {
        return {
            tier: 'UNDER_30M',
            label: '30분 미만',
            mainSets: (dayIdx === 9 || dayIdx === 34) ? 1 : 2, // 워밍업 1 + 본 세트 1~2 = 총 2~3세트
            targetMin: 18 + (dayIdx % 7), // 18 ~ 24분
            restSec: 50
        };
    }

    // [1시간 미만 정규 세션]: 일반 평일 표준 루틴
    return {
        tier: 'UNDER_60M',
        label: '1시간 미만',
        mainSets: (dayIdx < 15 ? 3 : 4), // 9월 전반 본세트 3, 후반 본세트 4 (총 4~5세트)
        targetMin: 38 + (dayIdx % 8), // 38 ~ 45분
        restSec: 68
    };
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

    // 특정 날짜 및 고중량/피로 세트에서의 현실적인 스마트 보조 개입 이벤트 설정
    const assistEventMap = {
        // 1. 2026-09-08: 첫 주말 직후 4세트 마지막 드랍세트 9회차 시도 중
        '2026-09-08_4': {
            repAtTrigger: 9,
            reductionKg: 5.0,
            heightPct: 42,
            reason: '중간 정체 1.4초 감지 (-5.0kg 감경 보조)',
            feedback: '[본 세트 3] 9회차 수축 지연으로 스마트 보조(-5.0kg) 개입. 안전하게 목표 반복 완수.'
        },
        // 2. 2026-09-15: 첫 65kg 증량 탑세트 7회차 시도 중
        '2026-09-15_2': {
            repAtTrigger: 7,
            reductionKg: 10.0,
            heightPct: 52,
            reason: '첫 65kg 증량 구간 7회차 정체 감지 (-10.0kg 감경 보조)',
            feedback: '[본 세트 1] 첫 65kg 탑 세트 7회차에서 정체 감지되어 스마트 보조(-10kg) 개입. 실패 지점 없이 목표 10회 안전 완수.'
        },
        // 3. 2026-09-22: 1시간 이상 고볼륨 세션 마지막 세트 8회차
        '2026-09-22_5': {
            repAtTrigger: 8,
            reductionKg: 7.5,
            heightPct: 46,
            reason: '후반 속도 급감 및 1.4초 정체 감지 (-7.5kg 부하 감경)',
            feedback: '[본 세트 4] 5세트 누적 피로 도달 시점에 스마트 감경(-7.5kg) 가동. 잔여 근섬유 안전 완수.'
        },
        // 4. 2026-09-29: 70kg 증량 탑세트 8회차 시도 중
        '2026-09-29_2': {
            repAtTrigger: 8,
            reductionKg: 10.0,
            heightPct: 55,
            reason: '70kg 고부하 중간 정체 1.4초 감지 (-10.0kg 감경 보조)',
            feedback: '[본 세트 1] 70kg 신기록 도전 탑세트 8회차에서 부하 한계 도달, 스마트 보조(-10kg)로 10회 돌파.'
        },
        // 5. 2026-10-04: 주말 고볼륨 4세트 9회차 시도 중
        '2026-10-04_4': {
            repAtTrigger: 9,
            reductionKg: 7.5,
            heightPct: 38,
            reason: '바텀 2.5초 지연 탈진 위험 감지 (-7.5kg 안전 리프트 보조)',
            feedback: '[본 세트 3] 바텀 피로 정체 감지 즉시 안전 보조(-7.5kg) 개입. 부상 방지 및 세트 완수.'
        },
        // 6. 2026-10-08: 오늘 75kg 최고 부하 도전 탑세트 8회차 시도 중!
        '2026-10-08_2': {
            repAtTrigger: 8,
            reductionKg: 10.0,
            heightPct: 54,
            reason: '최고 부하 75kg 구간 8회차 정체 감지 (-10.0kg 스마트 감경)',
            feedback: '[본 세트 1] 오늘 75kg 최고 부하 도전 중 8회차에서 스마트 보조(-10kg)가 즉시 개입하여 안전하게 10회 유효 수축을 완성했습니다.'
        }
    };

    dates.forEach((dateStr, dayIdx) => {
        const config = getDayBlockConfig(dayIdx);
        const baseWeight = config.baseWeight;
        const baseTempo = config.baseTempo;

        // 사용자의 가용 일정/시간대(Time Budget)에 따른 동적 세트 수 및 목표 시간 결정
        const budgetInfo = getTimeBudgetTier(dayIdx);
        const mainSetCount = budgetInfo.mainSets;
        const setCount = 1 + mainSetCount; // 워밍업 1세트 + 본 세트 N세트

        // 총 운동 시간(초) 산출: 30분 미만, 1시간 미만, 1시간 이상 명확히 분기
        const totalDurationSec = Math.round(budgetInfo.targetMin * 60 + ((dayIdx * 19) % 50));
        const durationFormatted = formatDurationSec(totalDurationSec);

        const startHour = 18 + (dayIdx % 3); // 18시, 19시, 20시
        let currentMinutes = 10 + (dayIdx % 15);
        let currentSeconds = 20;

        const warmupWeight = Math.round((baseWeight * 0.5) * 2) / 2;
        const dropWeight = Math.max(20, Math.round((baseWeight - 10.0) * 10) / 10);

        for (let s = 1; s <= setCount; s++) {
            const startStr = `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;

            let setType = 'MAIN';
            let setTypeLabel = '본 세트';
            let reps = 10;
            let targetReps = 10;
            let startLoadKg = baseWeight;
            let finalLoadKg = baseWeight;
            let assistLvl = 0;
            let startIntensityPct = 100;
            let finalIntensityPct = 100;
            let loadChanges = [];
            let isDroppedLoad = false;
            let coachFeedback = '';
            let repTempos = [];

            if (s === 1) {
                // Set 1: 워밍업 세트 (가벼운 무게로 20~30회 고반복 예열)
                setType = 'WARMUP';
                setTypeLabel = '워밍업';
                reps = (budgetInfo.tier === 'UNDER_30M') ? 20 : 25;
                targetReps = reps;
                startLoadKg = warmupWeight;
                finalLoadKg = warmupWeight;
                repTempos = Array.from({ length: reps }, (_, i) => Number((1.36 + (i % 5) * 0.03).toFixed(1)));
                coachFeedback = `[워밍업] 가벼운 부하(${warmupWeight}kg)로 ${reps}회 고반복 예열 완료 (${budgetInfo.label} 루틴). 관절 윤활액 분비 및 신경계 활성화.`;
            } else if (s === 2) {
                // Set 2: 본 세트 1 (탑 세트) - 최고 부하로 무게 확 늘림!
                setType = 'MAIN';
                setTypeLabel = '본 세트';
                reps = (budgetInfo.tier === 'UNDER_30M' && config.repsList && config.repsList[1]) ? config.repsList[1] : 10;
                targetReps = 10;
                startLoadKg = baseWeight;
                finalLoadKg = baseWeight;
                repTempos = Array.from({ length: reps }, (_, i) => Number((baseTempo + i * 0.03).toFixed(1)));
                coachFeedback = `[본 세트 1] 최고 부하 ${baseWeight}kg 탑 세트 완수 (${budgetInfo.label} 맞춤). 최대 수축 장력으로 본 세트 유효 반복 달성.`;
            } else {
                // Set 3 ~ N: 본 세트 2 ~ N (드랍 형식: 탑 세트에서 10kg 낮춰 고볼륨 소화)
                setType = 'MAIN';
                setTypeLabel = '본 세트';
                isDroppedLoad = true;
                startLoadKg = dropWeight; // 10kg 감량 드랍 형식!
                finalLoadKg = dropWeight;
                reps = (s === 3 ? 12 : (s === 4 ? 11 : 10)); // 감량 부하로 10~12회 수행
                targetReps = 12;
                repTempos = Array.from({ length: reps }, (_, i) => Number((baseTempo - 0.12 + (i % 6) * 0.03).toFixed(1)));
                const mainSetIdx = s - 1;
                coachFeedback = `[본 세트 ${mainSetIdx}] 부하 10kg 감량(${dropWeight}kg) 드랍 방식으로 ${reps}회 완수. 잔여 근섬유 완전 소진.`;
            }

            // 특정 핵심 고부하/피로 세트에 대한 스마트 보조 개입 이벤트 적용
            const assistKey = `${dateStr}_${s}`;
            const assistEvent = assistEventMap[assistKey];

            if (assistEvent) {
                assistLvl = 1;
                finalLoadKg = Math.max(20, Math.round((startLoadKg - assistEvent.reductionKg) * 10) / 10);
                startIntensityPct = 100;
                finalIntensityPct = Math.round((finalLoadKg / startLoadKg) * 100);
                
                const triggerTimeStr = `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;
                loadChanges = [{
                    time: triggerTimeStr,
                    set: s,
                    repAtTrigger: assistEvent.repAtTrigger,
                    totalRepsAtTrigger: reps,
                    heightPct: assistEvent.heightPct,
                    fromKg: startLoadKg,
                    toKg: finalLoadKg,
                    reductionKg: assistEvent.reductionKg,
                    fromPercent: 100,
                    toPercent: finalIntensityPct,
                    reductionPercent: 100 - finalIntensityPct,
                    reason: assistEvent.reason,
                    triggerType: 'smart_assist'
                }];
                coachFeedback = assistEvent.feedback;

                // 해당 변곡 랩에서 템포 지연 및 감경 후 속도 회복 모델링
                if (repTempos.length >= assistEvent.repAtTrigger) {
                    repTempos[assistEvent.repAtTrigger - 1] = Number((repTempos[assistEvent.repAtTrigger - 1] + 1.2).toFixed(1));
                    for (let r = assistEvent.repAtTrigger; r < repTempos.length; r++) {
                        repTempos[r] = Number((baseTempo - 0.1).toFixed(1));
                    }
                }
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
            const restSecThisSet = s === 1 ? 0 : (s >= 3 ? Math.min(55, budgetInfo.restSec) : budgetInfo.restSec);
            currentSeconds += restSecThisSet;
            while (currentSeconds >= 60) {
                currentMinutes += 1;
                currentSeconds -= 60;
            }

            const rec = createDetailedSetRecord({
                date: dateStr,
                set: s,
                setType: setType,
                setTypeLabel: setTypeLabel,
                isDroppedLoad: isDroppedLoad,
                timeBudget: budgetInfo.tier,
                timeBudgetLabel: budgetInfo.label,
                targetDurationMin: budgetInfo.targetMin,
                reps: reps,
                targetReps: targetReps,
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
