// 핀 번호 설정 (RGB 모듈 및 수동 부저 반영)
const int ledRed = 2;
const int ledGreen = 3;
const int ledBlue = 4;
const int buzzerPin = 13;
const int btnPin = 12; // 에이전트 시작 버튼 핀

bool isAgentActive = false; // 에이전트 판단 시작 여부 (초기값: 정지)
bool lastBtnState = HIGH;   // 이전 버튼 상태 기록용

void setup() {
  Serial.begin(9600);
  
  // 출력 핀 설정
  pinMode(ledRed, OUTPUT);
  pinMode(ledGreen, OUTPUT);
  pinMode(ledBlue, OUTPUT);
  pinMode(buzzerPin, OUTPUT);
  
  // 입력 핀 설정 (내부 풀업 저항 사용: 버튼을 안 누르면 HIGH, 누르면 LOW)
  pinMode(btnPin, INPUT_PULLUP);
}

void loop() {
  // 1. 버튼 입력 감지 (토글 방식: 누를 때마다 시작/정지 반복)
  bool currentBtnState = digitalRead(btnPin);
  
  if (lastBtnState == HIGH && currentBtnState == LOW) { // 버튼을 딱 누르는 순간 감지
    isAgentActive = !isAgentActive; // 상태 반전 (정지 -> 시작, 시작 -> 정지)
    delay(50); // 버튼 채터링(흔들림) 방지용 딜레이
  }
  lastBtnState = currentBtnState;

  // 2. 가변저항 값 읽기
  int sensorValue = analogRead(A0);
  
  // 3. 에이전트가 활성화(시작) 상태일 때만 Node.js로 값을 보내 판단을 요청함
  if (isAgentActive) {
    Serial.println(sensorValue);
  } 
  else {
    // 에이전트 비활성화(정지) 상태일 때는 모든 불과 소리를 끔
    digitalWrite(ledRed, LOW);
    digitalWrite(ledGreen, LOW);
    digitalWrite(ledBlue, LOW);
    noTone(buzzerPin);
  }
  
  // 4. Node.js(Agent)로부터 들어온 명령(신호)이 있는지 확인하여 하드웨어 제어
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    
    // 에이전트가 활성화 상태일 때만 서버의 명령을 수행
    if (isAgentActive) {
      if (cmd == 'H') {
        digitalWrite(ledRed, HIGH);
        digitalWrite(ledGreen, LOW);
        digitalWrite(ledBlue, LOW);
        tone(buzzerPin, 1000); 
      } 
      else if (cmd == 'N') {
        digitalWrite(ledRed, LOW);
        digitalWrite(ledGreen, HIGH);
        digitalWrite(ledBlue, LOW);
        noTone(buzzerPin);
      } 
      else if (cmd == 'L') {
        digitalWrite(ledRed, LOW);
        digitalWrite(ledGreen, LOW);
        digitalWrite(ledBlue, HIGH);
        noTone(buzzerPin);
      }
    }
  }
  
  delay(100);
}
