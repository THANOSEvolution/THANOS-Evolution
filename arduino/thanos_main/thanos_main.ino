/*
 * THANOS Evolution - Therapeutic Hand-Aid with Nerve Optimization Sensors
 * Main Arduino R4 WiFi Controller
 * 
 * Hardware:
 * - 5x Metal Gear Servos (Pins 3,5,6,9,10)
 * - GSR Sensor (Pin A0)
 * - EMG Sensor (Pin A1)
 * - MAX30102 (I2C: SDA, SCL)
 * - Emergency Stop Button (Pin 2)
 */

#include <Servo.h>
#include <Wire.h>
#include <WiFiS3.h>
#include "MAX30105.h"
#include "heartRate.h"

// ==================== CONFIGURATION ====================
#define NUM_FINGERS 5
#define SERVO_PINS {3, 5, 6, 9, 10} // Thumb, Index, Middle, Ring, Pinky
#define GSR_PIN A0
#define EMG_PIN A1
#define EMERGENCY_STOP_PIN 2

// WiFi Credentials
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Cloud API Endpoint
const char* API_ENDPOINT = "your-api-endpoint.com";
const int API_PORT = 443;

// Movement Parameters
#define SERVO_SPEED 5        // degrees per update
#define SERVO_UPDATE_MS 20   // 50Hz servo update
#define MAX_SERVO_CURRENT 800 // mA per servo safety limit

// ==================== GLOBAL OBJECTS ====================
Servo fingers[NUM_FINGERS];
int servoPins[NUM_FINGERS] = SERVO_PINS;
MAX30105 particleSensor;

// ==================== STATE VARIABLES ====================
int currentPose[NUM_FINGERS] = {0, 0, 0, 0, 0};
int targetPose[NUM_FINGERS] = {0, 0, 0, 0, 0};
bool movementActive = false;
bool emergencyStop = false;

// Sensor Data
float gsrValue = 0;
float emgValue = 0;
int heartRate = 0;
int spo2 = 0;

// Timing
unsigned long lastServoUpdate = 0;
unsigned long lastSensorRead = 0;
unsigned long lastCloudUpload = 0;
unsigned long sessionStartTime = 0;

String currentPoseName = "REST";
String sessionID = "";

// ==================== POSE DEFINITIONS ====================
struct Pose {
  String name;
  int angles[NUM_FINGERS]; // Thumb, Index, Middle, Ring, Pinky
};

Pose poses[] = {
  {"REST", {0, 0, 0, 0, 0}},
  {"FIST", {90, 180, 180, 180, 180}},
  {"OPEN", {45, 0, 0, 0, 0}},
  {"ONE", {90, 0, 180, 180, 180}},
  {"TWO", {90, 0, 0, 180, 180}},
  {"THREE", {90, 0, 0, 0, 180}},
  {"FOUR", {90, 0, 0, 0, 0}},
  {"FIVE", {45, 0, 0, 0, 0}},
  {"L_SHAPE", {0, 0, 180, 180, 180}},
  {"BAD_FINGER", {90, 180, 0, 180, 180}},
  {"SPIDERMAN", {0, 0, 180, 180, 0}},
  {"EYY", {0, 0, 180, 180, 180}},
  {"ROCK_ROLL", {0, 0, 180, 180, 0}}, // Pinky and index extended
  {"TWO_JOINT", {90, 180, 180, 90, 90}} // Ring and pinky partial
};

const int NUM_POSES = sizeof(poses) / sizeof(poses[0]);

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000); // Wait for serial or 3s timeout
  
  Serial.println("=== THANOS Evolution Initializing ===");
  
  // Emergency Stop Button
  pinMode(EMERGENCY_STOP_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(EMERGENCY_STOP_PIN), emergencyStopISR, FALLING);
  
  // Initialize Servos
  initServos();
  
  // Initialize Sensors
  initSensors();
  
  // Initialize WiFi
  initWiFi();
  
  // Generate Session ID
  sessionID = String(millis()) + "_" + String(random(10000));
  sessionStartTime = millis();
  
  Serial.println("=== System Ready ===");
  Serial.println("Available Commands:");
  Serial.println("  pose <name> - Execute pose");
  Serial.println("  list - Show all poses");
  Serial.println("  stop - Emergency stop");
  Serial.println("  data - Show sensor data");
}

// ==================== MAIN LOOP ====================
void loop() {
  // Check Emergency Stop
  if (emergencyStop) {
    handleEmergencyStop();
    return;
  }
  
  // Update Servos (50Hz)
  if (millis() - lastServoUpdate >= SERVO_UPDATE_MS) {
    updateServoPositions();
    lastServoUpdate = millis();
  }
  
  // Read Sensors (100Hz for EMG, 10Hz for others)
  if (millis() - lastSensorRead >= 10) {
    readSensors();
    lastSensorRead = millis();
  }
  
  // Upload to Cloud (every 5 seconds)
  if (millis() - lastCloudUpload >= 5000) {
    uploadToCloud();
    lastCloudUpload = millis();
  }
  
  // Process Serial Commands
  if (Serial.available()) {
    processCommand(Serial.readStringUntil('\n'));
  }
}

// ==================== INITIALIZATION FUNCTIONS ====================
void initServos() {
  Serial.println("Initializing servos...");
  for (int i = 0; i < NUM_FINGERS; i++) {
    fingers[i].attach(servoPins[i]);
    fingers[i].write(0); // Start at rest position
    currentPose[i] = 0;
    targetPose[i] = 0;
    delay(100);
  }
  Serial.println("✓ Servos initialized");
}

void initSensors() {
  Serial.println("Initializing sensors...");
  
  // MAX30102
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("✗ MAX30102 not found");
  } else {
    particleSensor.setup();
    particleSensor.setPulseAmplitudeRed(0x0A);
    particleSensor.setPulseAmplitudeGreen(0);
    Serial.println("✓ MAX30102 initialized");
  }
  
  // GSR and EMG are analog, no init needed
  Serial.println("✓ GSR and EMG ready");
}

void initWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✓ WiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n✗ WiFi connection failed - continuing offline");
  }
}

// ==================== SERVO CONTROL ====================
void updateServoPositions() {
  movementActive = false;
  
  for (int i = 0; i < NUM_FINGERS; i++) {
    if (currentPose[i] != targetPose[i]) {
      movementActive = true;
      
      // Calculate next position
      int diff = targetPose[i] - currentPose[i];
      int step = (diff > 0) ? min(SERVO_SPEED, diff) : max(-SERVO_SPEED, diff);
      
      currentPose[i] += step;
      fingers[i].write(currentPose[i]);
    }
  }
}

void setPose(String poseName) {
  poseName.toUpperCase();
  
  for (int i = 0; i < NUM_POSES; i++) {
    if (poses[i].name == poseName) {
      Serial.print("Executing pose: ");
      Serial.println(poseName);
      
      currentPoseName = poseName;
      
      for (int j = 0; j < NUM_FINGERS; j++) {
        targetPose[j] = poses[i].angles[j];
      }
      return;
    }
  }
  
  Serial.println("✗ Pose not found");
}

// ==================== SENSOR READING ====================
void readSensors() {
  // GSR (Galvanic Skin Response)
  gsrValue = analogRead(GSR_PIN);
  
  // EMG (Electromyography)
  emgValue = analogRead(EMG_PIN);
  
  // MAX30102 (Heart Rate & SpO2)
  long irValue = particleSensor.getIR();
  
  if (irValue > 50000) { // Finger detected
    heartRate = particleSensor.getHeartRate();
    spo2 = particleSensor.getSpO2();
  }
}

// ==================== CLOUD INTEGRATION ====================
void uploadToCloud() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  
  // Create JSON payload
  String payload = createDataPayload();
  
  WiFiClient client;
  
  if (client.connect(API_ENDPOINT, API_PORT)) {
    client.println("POST /api/thanos/data HTTP/1.1");
    client.print("Host: ");
    client.println(API_ENDPOINT);
    client.println("Content-Type: application/json");
    client.print("Content-Length: ");
    client.println(payload.length());
    client.println();
    client.println(payload);
    
    Serial.println("✓ Data uploaded to cloud");
  } else {
    Serial.println("✗ Cloud connection failed");
  }
  
  client.stop();
}

String createDataPayload() {
  String json = "{";
  json += "\"session_id\":\"" + sessionID + "\",";
  json += "\"timestamp\":" + String(millis()) + ",";
  json += "\"pose\":\"" + currentPoseName + "\",";
  json += "\"servo_positions\":[" + String(currentPose[0]) + "," + String(currentPose[1]) + "," + String(currentPose[2]) + "," + String(currentPose[3]) + "," + String(currentPose[4]) + "],";
  json += "\"gsr\":" + String(gsrValue) + ",";
  json += "\"emg\":" + String(emgValue) + ",";
  json += "\"heart_rate\":" + String(heartRate) + ",";
  json += "\"spo2\":" + String(spo2) + ",";
  json += "\"session_duration\":" + String((millis() - sessionStartTime) / 1000);
  json += "}";
  return json;
}

// ==================== COMMAND PROCESSING ====================
void processCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  
  if (cmd.startsWith("pose ")) {
    String poseName = cmd.substring(5);
    setPose(poseName);
  }
  else if (cmd == "list") {
    Serial.println("\nAvailable Poses:");
    for (int i = 0; i < NUM_POSES; i++) {
      Serial.print("  - ");
      Serial.println(poses[i].name);
    }
  }
  else if (cmd == "stop") {
    emergencyStop = true;
    Serial.println("EMERGENCY STOP ACTIVATED");
  }
  else if (cmd == "data") {
    printSensorData();
  }
  else if (cmd == "resume") {
    emergencyStop = false;
    Serial.println("System resumed");
  }
  else {
    Serial.println("Unknown command");
  }
}

void printSensorData() {
  Serial.println("\n=== Sensor Data ===");
  Serial.print("GSR: "); Serial.println(gsrValue);
  Serial.print("EMG: "); Serial.println(emgValue);
  Serial.print("Heart Rate: "); Serial.print(heartRate); Serial.println(" bpm");
  Serial.print("SpO2: "); Serial.print(spo2); Serial.println("%");
  Serial.print("Current Pose: "); Serial.println(currentPoseName);
  Serial.print("Moving: "); Serial.println(movementActive ? "Yes" : "No");
  Serial.println("==================\n");
}

// ==================== SAFETY FUNCTIONS ====================
void emergencyStopISR() {
  emergencyStop = true;
}

void handleEmergencyStop() {
  // Stop all servos
  for (int i = 0; i < NUM_FINGERS; i++) {
    fingers[i].detach();
  }
  
  Serial.println("!!! EMERGENCY STOP ACTIVE !!!");
  Serial.println("Type 'resume' to restart system");
  
  delay(1000); // Prevent spam
}
