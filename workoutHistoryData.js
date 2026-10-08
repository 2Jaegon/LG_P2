/**
 * workoutHistoryData.js
 * 2026년 9월 1일부터 2026년 10월 7일(어제)까지의 실감형 AI 운동 일지 데이터 생성 모듈
 */

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
        startTime: data.startTime || '18:00:00',
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
                    : `높은 속도 일관성 유지 -> 다음 세트 동일 부하 유지 또는 목표 1회 증량 도전 추천`)
        }
    };
}

/**
 * 2026-09-01부터 2026-10-07(어제)까지의 일지 데이터 생성기
 */
function generateWorkoutHistory() {
    const dates = [];
    // 9월 1일 ~ 9월 30일 (30일)
    for (let d = 1; d <= 30; d++) {
        dates.push(`2026-09-${String(d).padStart(2, '0')}`);
    }
    // 10월 1일 ~ 10월 7일 (7일)
    for (let d = 1; d <= 7; d++) {
        dates.push(`2026-10-${String(d).padStart(2, '0')}`);
    }

    const history = [];

    dates.forEach((dateStr, dayIdx) => {
        // 점진적 과부하(Progressive Overload) 곡선
        // 9월 초: 60.0kg ~ 62.0kg -> 9월 중순: 63.0kg ~ 66.0kg -> 9월 말: 67.0kg ~ 69.0kg -> 10월: 70.0kg
        let baseWeight = 60.0;
        if (dayIdx < 10) {
            baseWeight = 60.0 + (dayIdx * 0.25);
        } else if (dayIdx < 20) {
            baseWeight = 62.5 + ((dayIdx - 10) * 0.35);
        } else if (dayIdx < 30) {
            baseWeight = 66.0 + ((dayIdx - 20) * 0.35);
        } else {
            baseWeight = 70.0;
        }
        baseWeight = Math.round(baseWeight * 10) / 10;

        // 요일 계산 (2026-09-01은 화요일)
        const dayOfWeek = (dayIdx + 2) % 7; // 0: 일, 1: 월, ... 6: 토
        const isSunday = (dayOfWeek === 0);
        const setCount = isSunday ? 2 : (dayIdx % 3 === 0 ? 4 : 3);

        const startHour = 18 + (dayIdx % 3); // 18시, 19시, 20시
        let currentMinutes = 10 + (dayIdx % 15);
        let currentSeconds = 20;

        for (let s = 1; s <= setCount; s++) {
            const startStr = `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;
            
            // 세트 수행 시간 약 28~35초
            currentSeconds += 30;
            if (currentSeconds >= 60) {
                currentMinutes += 1;
                currentSeconds -= 60;
            }
            const completeStr = `${String(startHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;
            
            // 세트 간 휴식 시간 (약 60초)
            currentMinutes += 1;

            let reps = 10;
            let assistLvl = 0;
            let startLoadKg = baseWeight;
            let finalLoadKg = baseWeight;
            let startIntensityPct = 100;
            let finalIntensityPct = 100;
            let loadChanges = [];
            let coachFeedback = '';

            // 점진적 VBT 템포 개선 (9월 2.4s -> 10월 1.9s)
            const baseTempo = Math.max(1.85, 2.45 - (dayIdx * 0.016));
            let repTempos = [];

            if (s === 1) {
                reps = 10;
                assistLvl = 0;
                repTempos = Array.from({ length: 10 }, (_, i) => Number((baseTempo + i * 0.04).toFixed(1)));
                coachFeedback = "첫 세트 가동범위와 템포가 매우 균일하고 안정적이었습니다.";
            } else if (s === 2) {
                reps = 10;
                assistLvl = 0;
                repTempos = Array.from({ length: 10 }, (_, i) => Number((baseTempo + 0.08 + i * 0.06).toFixed(1)));
                coachFeedback = "2세트 연속 목표 반복 완수. 최상의 VBT 파워 출력을 유지했습니다.";
            } else if (s === 3) {
                // 이틀에 한 번꼴로 3세트 후반에 피로 감지 -> 5kg 스마트 어시스트 감량 발동
                if (dayIdx % 2 === 1 && !isSunday) {
                    reps = 9;
                    assistLvl = 1;
                    finalLoadKg = Math.max(10, Math.round((baseWeight - 5.0) * 10) / 10);
                    finalIntensityPct = 85;
                    loadChanges = [{
                        time: completeStr,
                        fromKg: baseWeight,
                        toKg: finalLoadKg,
                        fromPercent: 100,
                        toPercent: 85,
                        reason: '7회차 정체 감지 (-5.0kg 부하 감소)',
                        repAtTrigger: 7,
                        heightPct: 52
                    }];
                    repTempos = Array.from({ length: 9 }, (_, i) => Number((baseTempo + 0.15 + (i >= 7 ? -0.1 : i * 0.08)).toFixed(1)));
                    coachFeedback = "7회차 정체 발생 시 스마트 어시스트가 개입하여 목표 랩을 안전하게 소화했습니다.";
                } else {
                    reps = 9;
                    assistLvl = 0;
                    repTempos = Array.from({ length: 9 }, (_, i) => Number((baseTempo + 0.12 + i * 0.07).toFixed(1)));
                    coachFeedback = "누적 피로 속에서도 감경 없이 끝까지 집중하여 안정된 리듬을 유지했습니다.";
                }
            } else if (s === 4) {
                if (dayIdx % 2 === 1) {
                    reps = 8;
                    assistLvl = 1;
                    startLoadKg = Math.max(10, Math.round((baseWeight - 5.0) * 10) / 10);
                    finalLoadKg = startLoadKg;
                    startIntensityPct = 85;
                    finalIntensityPct = 85;
                    repTempos = Array.from({ length: 8 }, (_, i) => Number((baseTempo + 0.22 + i * 0.07).toFixed(1)));
                    coachFeedback = "마지막 세트 피로 누적 상황에서도 감경된 부하로 목표 볼륨을 안전하게 달성했습니다.";
                } else {
                    reps = 9;
                    assistLvl = 0;
                    repTempos = Array.from({ length: 9 }, (_, i) => Number((baseTempo + 0.18 + i * 0.06).toFixed(1)));
                    coachFeedback = "강한 정신력으로 4세트 전 구간 고출력 파워를 유지하며 오늘 운동을 마쳤습니다.";
                }
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
                restBeforeSetSeconds: s === 1 ? 0 : (58 + (dayIdx % 8)),
                coachFeedbackSnippet: coachFeedback
            });

            history.push(rec);
        }
    });

    return history;
}

const initialSetHistory = generateWorkoutHistory();

module.exports = {
    createDetailedSetRecord,
    generateWorkoutHistory,
    initialSetHistory
};
