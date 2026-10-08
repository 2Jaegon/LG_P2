// 핀 번호 설정 (RGB 모듈 및 수동 부저 반영)
const int ledRed = 2;
const int ledGreen = 3;
const int ledBlue = 4;
const int buzzerPin = 13;

// 시나리오 버튼 핀 설정
const int btn1Pin = 11; // 1번 버튼: 바 신체 이탈 감지 및 위치 고정
const int btn2Pin = 12; // 2번 버튼: 좌우 힘 불균형 감지 시나리오

bool isAgentActive = true; // 에이전트 기본 활성화 상태

// 버튼 디바운스 및 상태 추적 변수
bool lastBtn1State = HIGH;
bool lastBtn2State = HIGH;
unsigned long lastBtn1DebounceTime = 0;
unsigned long lastBtn2DebounceTime = 0;
const unsigned long debounceDelay = 150; // 디바운스 지연 시간 (ms)

void setup() {
  Serial.begin(9600);
  
  // 출력 핀 설정
  pinMode(ledRed, OUTPUT);
  pinMode(ledGreen, OUTPUT);
  pinMode(ledBlue, OUTPUT);
  pinMode(buzzerPin, OUTPUT);
  
  // 입력 핀 설정 (내부 풀업 저항 사용: 버튼 누르면 LOW)
  pinMode(btn1Pin, INPUT_PULLUP);
  pinMode(btn2Pin, INPUT_PULLUP);

  // 초기 상태: 정상(초록 불)
  digitalWrite(ledRed, LOW);
  digitalWrite(ledGreen, HIGH);
  digitalWrite(ledBlue, LOW);
  noTone(buzzerPin);
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. 1번 버튼 (11번 핀: 신체 이탈 감지) 누름 이벤트 감지
  int reading1 = digitalRead(btn1Pin);
  if (reading1 == LOW && lastBtn1State == HIGH) {
    if (currentMillis - lastBtn1DebounceTime > debounceDelay) {
      Serial.println("BTN1_PRESS");
      lastBtn1DebounceTime = currentMillis;
    }
  }
  lastBtn1State = reading1;

  // 2. 2번 버튼 (12번 핀: 좌우 불균형 감지) 누름 이벤트 감지
  int reading2 = digitalRead(btn2Pin);
  if (reading2 == LOW && lastBtn2State == HIGH) {
    if (currentMillis - lastBtn2DebounceTime > debounceDelay) {
      Serial.println("BTN2_PRESS");
      lastBtn2DebounceTime = currentMillis;
    }
  }
  lastBtn2State = reading2;

  // 3. 가변저항 값 읽기 및 전송
  int sensorValue = analogRead(A0);
  if (isAgentActive) {
    Serial.println(sensorValue);
  }

  // 4. Node.js(Agent)로부터 들어온 명령(신호)이 있는지 확인하여 하드웨어 제어
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == 'H') { // DANGER / 바 고정 (적색 LED + 부저)
      digitalWrite(ledRed, HIGH);
      digitalWrite(ledGreen, LOW);
      digitalWrite(ledBlue, LOW);
      tone(buzzerPin, 1000); 
    } 
    else if (cmd == 'N') { // NORMAL 정상 (녹색 LED)
      digitalWrite(ledRed, LOW);
      digitalWrite(ledGreen, HIGH);
      digitalWrite(ledBlue, LOW);
      noTone(buzzerPin);
    } 
    else if (cmd == 'L') { // ASSIST / 불균형 (청색 LED)
      digitalWrite(ledRed, LOW);
      digitalWrite(ledGreen, LOW);
      digitalWrite(ledBlue, HIGH);
      noTone(buzzerPin);
    }
  }
  
  delay(100);
}
