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

try {
    port = new SerialPort({ path: ARDUINO_PORT, baudRate: BAUD_RATE });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    console.log(`Trying to connect to Arduino on ${ARDUINO_PORT}...`);

    port.on('open', () => {
        console.log(`Successfully connected to Arduino on ${ARDUINO_PORT}`);
    });

    port.on('error', (err) => {
        console.log('Error: ', err.message);
    });

    // 아두이노에서 데이터 수신 (버튼이 켜져 있을 때만 데이터가 들어옴)
    parser.on('data', (data) => {
        const value = parseInt(data.trim(), 10);
        if (!isNaN(value)) {
            sensorDataBuffer.push(value);
            lastValue = value;
            
            // 빠른 움직임 감지용 버퍼 유지 (최근 데이터 최대 10개)
            recentDataBuffer.push(value);
            if (recentDataBuffer.length > 10) recentDataBuffer.shift();

            // 현재 DANGER 상태일 때, 최근 데이터 변동폭이 200 이상이면 즉시 NORMAL로 복구 (확실하게 움직였을 때만 해제)
            if (currentStatus === 'DANGER' && recentDataBuffer.length === 10) {
                const rMax = Math.max(...recentDataBuffer);
                const rMin = Math.min(...recentDataBuffer);
                if (rMax - rMin >= 200) {
                    currentStatus = 'NORMAL';
                    console.log("\n[시스템 긴급 개입] 움직임 재개 감지 - 경고 즉시 해제");
                    
                    // 하드웨어 경고 해제 신호
                    if (port) port.write('N\n');
                    
                    // 웹 대시보드 경고 즉시 해제
                    io.emit('sensorData', {
                        value: value,
                        status: 'NORMAL',
                        decision: "[시스템] 움직임이 다시 감지되어 경고가 해제되었습니다."
                    });
                }
            }
            
            // 센서 값은 실시간으로 웹에 표시
            io.emit('sensorData', {
                value: value
            });
        }
    });

} catch (error) {
    console.error("Failed to initialize SerialPort:", error.message);
}

// 6초마다 버퍼에 쌓인 데이터를 로컬 LLM으로 분석 요청
setInterval(() => {
    // 데이터가 최소 5개 이상 모였을 때만 분석 실행 (버튼 눌러서 시작된 경우)
    if (sensorDataBuffer.length > 5 && !isAnalyzing) { 
        const dataToAnalyze = [...sensorDataBuffer];
        sensorDataBuffer = []; // 다음 6초 배치를 위해 버퍼 비우기
        analyzeWithLLM(dataToAnalyze);
    }
}, 6000);

async function analyzeWithLLM(dataArray) {
    isAnalyzing = true;
    
    const maxVal = Math.max(...dataArray);
    const minVal = Math.min(...dataArray);
    const diff = maxVal - minVal;

    try {
        console.log(`\n[LLM 요청] ${dataArray.length}개의 데이터 분석 시작 (변동폭: ${diff})`);
        
        // 시연을 위해 DANGER 판단 기준을 변동폭 150 미만으로 넉넉하게 잡음
        const systemStatus = diff < 150 ? "DANGER" : "NORMAL";

        // Qwen에게 보낼 프롬프트
        const prompt = `당신은 헬스장 운동기구의 움직임을 모니터링하는 AI 코치입니다.
시스템이 판별한 현재 상태는 "${systemStatus}" 입니다.

지시사항:
- 상태가 "DANGER"인 경우: "위험! 즉시 중량 감소 및 부하 제거가 필요합니다." 라는 강력한 경고 문구를 작성하세요.
- 상태가 "NORMAL"인 경우: "아주 좋습니다! 안정적인 페이스입니다." 등의 짧은 격려 문구를 작성하세요.

반드시 아래 JSON 형식으로만 답변하세요. (예시의 괄호를 그대로 쓰지 말고, 실제로 문구를 지어내세요)
{
  "status": "${systemStatus}",
  "action": "여기에 실제 한국어 응원 또는 경고 문구를 작성하세요",
  "hardware_signal": "${systemStatus === 'DANGER' ? 'H' : 'N'}"
}`;

        // Ollama API 로컬 호출 (Node 18+ fetch 사용)
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen', // 사용 중인 모델명 (예: qwen, qwen2 등)
                prompt: prompt,
                stream: false,
                format: 'json' // JSON 형태의 응답을 강제함
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama 서버 에러: ${response.status}`);
        }

        const result = await response.json();
        const llmReply = JSON.parse(result.response);
        
        // LLM이 지시를 무시하고 오판(환각)할 경우를 대비해, 상태값은 시스템 판별값을 강제 적용
        llmReply.status = systemStatus;
        llmReply.hardware_signal = systemStatus === 'DANGER' ? 'H' : 'N';
        
        // Qwen 모델이 문구를 짓지 않고 지시문을 그대로 복사하는 경우를 대비한 기본 텍스트(Fallback)
        if (!llmReply.action || llmReply.action.includes('작성') || llmReply.action.includes('여기에')) {
            llmReply.action = systemStatus === 'DANGER' 
                ? "경고: 한계 도달! 즉시 중량을 감소하거나 부하를 제거하세요." 
                : "운동 페이스가 좋습니다. 계속 유지하세요!";
        }
        
        currentStatus = llmReply.status;
        console.log("[LLM 판단 완료]:", llmReply);

        // 아두이노로 하드웨어 제어 신호(H 또는 N) 전송
        if (llmReply.hardware_signal && port) {
            port.write(llmReply.hardware_signal + '\n');
        }

        // 웹 대시보드로 AI의 최종 판단 텍스트 전송
        io.emit('sensorData', {
            value: lastValue,
            status: llmReply.status,
            decision: `[Qwen 에이전트] ${llmReply.action}`
        });

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
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
