'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header from '@/components/dashboard/header';
import SensorPanel from '@/components/dashboard/sensor-panel';
import ValveControlPanel from '@/components/dashboard/valve-control-panel';
// --- 1. 모터 패널 컴포넌트 import ---
import MotorControlPanel from '@/components/dashboard/motor-control-panel'; 
import SequencePanel from '@/components/dashboard/sequence-panel';
import DataChartPanel from '@/components/dashboard/data-chart-panel';
import TerminalPanel from '@/components/dashboard/terminal-panel';
import { useToast } from "@/hooks/use-toast";
import { AppConfig } from '@/types';

// Data types
export interface SensorData {
  pt1: number;
  pt2: number;
  pt3: number;
  pt4: number;
  flow1: number;
  flow2: number;
  tc1: number;
  timestamp: number;
}

export type ValveState = 'OPEN' | 'CLOSED' | 'OPENING' | 'CLOSING' | 'ERROR';

export interface Valve {
  id: number;
  name: string;
  state: ValveState;
  lsOpen: boolean;
  lsClosed: boolean;
}

// --- 2. 모터 데이터 타입 정의 ---
export interface MotorData {
  name: string;
  angle: number;
}

const initialValves: Valve[] = [
  { id: 1, name: 'Ethanol Main', state: 'CLOSED', lsOpen: false, lsClosed: false },
  { id: 2, name: 'N2O Main', state: 'CLOSED', lsOpen: false, lsClosed: false },
  { id: 3, name: 'Ethanol Purge', state: 'CLOSED', lsOpen: false, lsClosed: false },
  { id: 4, name: 'N2O Purge', state: 'CLOSED', lsOpen: false, lsClosed: false },
  { id: 5, name: 'Pressurant Fill', state: 'CLOSED', lsOpen: false, lsClosed: false },
  { id: 6, name: 'System Vent', state: 'CLOSED', lsOpen: false, lsClosed: false },
  { id: 7, name: 'Igniter Fuel', state: 'CLOSED', lsOpen: false, lsClosed: false },
];


const MAX_CHART_DATA_POINTS = 100;
const PRESSURE_LIMIT = 850; // PSI

export default function Home() {
  const { toast } = useToast();
  const [sensorData, setSensorData] = useState<SensorData | null>(null);
  const [chartData, setChartData] = useState<SensorData[]>([]);
  const [valves, setValves] = useState<Valve[]>(initialValves);
  // --- 3. 모터 상태를 관리할 state 추가 ---
  const [motors, setMotors] = useState<MotorData[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [sequenceLogs, setSequenceLogs] = useState<string[]>(['System standby. Select a sequence to begin.']);
  const [activeSequence, setActiveSequence] = useState<string | null>(null);
  
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>('');
  const [isLogging, setIsLogging] = useState(false);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);

  const sequenceTimeoutRef = useRef<NodeJS.Timeout[]>([]);
  const emergencyShutdownTriggered = useRef(false);
  const ignitionPhase = useRef<'idle' | 'igniter' | 'main_stage'>('idle');

  useEffect(() => {
    // Zoom control
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) {
          window.electronAPI.zoomIn();
        } else {
          window.electronAPI.zoomOut();
        }
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey) {
        if (event.key === '=') {
          event.preventDefault();
          window.electronAPI.zoomIn();
        } else if (event.key === '-') {
          event.preventDefault();
          window.electronAPI.zoomOut();
        } else if (event.key === '0') {
          event.preventDefault();
          window.electronAPI.zoomReset();
        }
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const getPorts = async () => {
      const ports = await window.electronAPI.getSerialPorts();
      setSerialPorts(ports);
      if (ports.length > 0) {
        setSelectedPort(ports[0]);
      }
    };
    getPorts();

    const loadConfig = async () => {
      const cfg = await window.electronAPI.getConfig();
      setAppConfig(cfg);
      // --- 4. 설정 파일 로드 후 모터 상태 초기화 ---
      if (cfg?.motorMappings) {
        const initialMotors = Object.keys(cfg.motorMappings).map(motorName => ({
          name: motorName,
          angle: 90, // 모든 모터의 초기 각도를 90도로 설정
        }));
        setMotors(initialMotors);
      }
    };
    loadConfig();

    const handleSerialData = (data: string) => {
      addLog(`Received: ${data}`);
      // Assuming data format is "key1:value1,key2:value2,..."
      const parts = data.split(',');
      const newData: Partial<SensorData> = {};
      const newValveStates: Partial<Record<number, Partial<Valve>>> = {};

      parts.forEach(part => {
        const [key, rawValue] = part.split(':');
        if (!key || !rawValue) return;
        const value = rawValue.trim();

        // Update sensor data
        if (Object.keys(sensorData || {}).includes(key)) {
            (newData as any)[key] = parseFloat(value);
        }

        // Update valve states based on limit switches
        const match = key.match(/V(\d)(LS_OPEN|LS_CLOSED)/);
        if (match) {
            const valveId = parseInt(match[1]);
            const lsType = match[2];
            const lsValue = value === '1';
            if (!newValveStates[valveId]) newValveStates[valveId] = {};
            if (lsType === 'LS_OPEN') newValveStates[valveId]!.lsOpen = lsValue;
            if (lsType === 'LS_CLOSED') newValveStates[valveId]!.lsClosed = lsValue;
        }
      });
      
      if (Object.keys(newData).length > 0) {
        const updatedSensorData = { ...sensorData, ...newData, timestamp: Date.now() } as SensorData;
        setSensorData(updatedSensorData);
        setChartData(prev => [...prev.slice(-MAX_CHART_DATA_POINTS + 1), updatedSensorData]);
        
        if ((updatedSensorData.pt1 > PRESSURE_LIMIT || updatedSensorData.pt2 > PRESSURE_LIMIT) && !emergencyShutdownTriggered.current) {
          addLog(`!!! CRITICAL PRESSURE DETECTED (PT1: ${updatedSensorData.pt1.toFixed(0)} PSI, PT2: ${updatedSensorData.pt2.toFixed(0)} PSI) !!!`);
          handleSequence("Emergency Shutdown");
          emergencyShutdownTriggered.current = true;
        } else if (updatedSensorData.pt1 < PRESSURE_LIMIT && updatedSensorData.pt2 < PRESSURE_LIMIT) {
            emergencyShutdownTriggered.current = false;
        }
      }

      if(Object.keys(newValveStates).length > 0) {
        setValves(prevValves => prevValves.map(v => {
            const updates = newValveStates[v.id];
            if (!updates) return v;
            
            let finalState: ValveState = v.state;
            if (updates.state) { 
                finalState = updates.state;
            } else if (updates.lsOpen) {
                finalState = 'OPEN';
            } else if (updates.lsClosed) {
                finalState = 'CLOSED';
            }
            
            return {...v, ...updates, state: finalState };
        }));
      }
    };

    const handleSerialError = (error: string) => {
        addLog(`SERIAL ERROR: ${error}`);
        toast({ title: "Serial Port Error", description: error, variant: "destructive" });
        setConnectionStatus('disconnected');
    };

    const cleanupSerialData = window.electronAPI.onSerialData(handleSerialData);
    const cleanupSerialError = window.electronAPI.onSerialError(handleSerialError);

    return () => {
      cleanupSerialData();
      cleanupSerialError();
      sequenceTimeoutRef.current.forEach(clearTimeout);
    };
  }, [sensorData]);

  useEffect(() => {
    window.electronAPI.onLogCreationFailed(() => {
      toast({ title: "Logging Error", description: "Failed to create log file.", variant: "destructive" });
    });
  }, [toast]);

  const handleConnect = async () => {
    if (connectionStatus === 'connected') {
      await window.electronAPI.disconnectSerial();
      setConnectionStatus('disconnected');
      addLog(`Disconnected from ${selectedPort}.`);
    } else {
      if (!selectedPort) {
        toast({ title: "Connection Error", description: "Please select a serial port.", variant: "destructive" });
        return;
      }
      setConnectionStatus('connecting');
      addLog(`Connecting to ${selectedPort}...`);
      const success = await window.electronAPI.connectSerial(selectedPort);
      if (success) {
        setConnectionStatus('connected');
        addLog(`Successfully connected to ${selectedPort}.`);
      } else {
        setConnectionStatus('disconnected');
        addLog(`Failed to connect to ${selectedPort}.`);
      }
    }
  };

  const sendCommand = (cmd: string) => {
    if (connectionStatus !== 'connected') {
        toast({ title: "Not Connected", description: "Must be connected to a serial port to send commands.", variant: "destructive" });
        return;
    }
    window.electronAPI.sendToSerial(cmd);
    addLog(`Sent: ${cmd}`);
  };

  const handleValveChange = useCallback((valveId: number, targetState: 'OPEN' | 'CLOSED') => {
    const valve = valves.find(v => v.id === valveId);
    if (!valve) return;

    const mapping = appConfig?.valveMappings?.[valve.name];
    if (!mapping) {
        toast({ title: "Command Error", description: `No servo mapping for valve ${valve.name}.`, variant: "destructive" });
        return;
    }

    const command = `V,${mapping.servoIndex},${targetState === 'OPEN' ? 'O' : 'C'}`;
    sendCommand(command);

    setValves(prevValves => prevValves.map(v => 
      v.id === valveId 
        ? { ...v, state: targetState }
        : v
    ));
  }, [valves, connectionStatus, toast, appConfig]);
  
  // --- 5. 모터 각도 변경을 처리하는 핸들러 함수 추가 ---
  const handleMotorAngleChange = useCallback((motorName: string, angle: number) => {
    const mapping = appConfig?.motorMappings?.[motorName];
    if (!mapping) {
      toast({ title: "Command Error", description: `No servo mapping for motor ${motorName}.`, variant: "destructive" });
      return;
    }

    // 아두이노로 보낼 명령어 생성 (예: "M,4,120")
    const command = `M,${mapping.servoIndex},${Math.round(angle)}`;
    sendCommand(command);

    // UI를 즉시 업데이트
    setMotors(prevMotors => prevMotors.map(m =>
      m.name === motorName
        ? { ...m, angle: angle }
        : m
    ));
  }, [connectionStatus, toast, appConfig]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setSequenceLogs(prev => [...prev, `[${timestamp}] ${message}`]);
  };

  const handleLoggingToggle = () => {
    if (isLogging) {
      window.electronAPI.stopLogging();
      setIsLogging(false);
    } else {
      window.electronAPI.startLogging();
      setIsLogging(true);
    }
  };

  const clearAndRunSequence = (name: string, steps: { message: string, delay: number, action?: () => void }[]) => {
    setActiveSequence(name);
    setSequenceLogs([]);
    sequenceTimeoutRef.current.forEach(clearTimeout);
    sequenceTimeoutRef.current = [];
    
    let cumulativeDelay = 0;
    
    addLog(`Initiating sequence: ${name}`);

    steps.forEach((step, index) => {
      cumulativeDelay += step.delay;
      const timeout = setTimeout(() => {
        addLog(step.message);
        step.action?.();
        if (index === steps.length - 1) {
            addLog(`Sequence ${name} complete.`);
            setActiveSequence(null);
            ignitionPhase.current = 'idle';
        }
      }, cumulativeDelay);
      sequenceTimeoutRef.current.push(timeout);
    });
  };

  const handleSequence = (sequenceName: string) => {
    if (activeSequence) {
        toast({
            title: "Sequence in Progress",
            description: `Cannot start "${sequenceName}" while "${activeSequence}" is running.`,
            variant: "destructive",
        });
        return;
    }

    switch (sequenceName) {
        case "Ignition Sequence":
            ignitionPhase.current = 'idle';
            clearAndRunSequence("Ignition Sequence", [
                { message: "Sending command: IGNITION_SEQUENCE_START", delay: 500, action: () => sendCommand("SEQ_IGNITION_START") },
            ]);
            break;
        case "Emergency Shutdown":
            ignitionPhase.current = 'idle';
            clearAndRunSequence("Emergency Shutdown", [
                { message: "Sending command: EMERGENCY_SHUTDOWN", delay: 100, action: () => sendCommand("SEQ_SHUTDOWN") },
            ]);
            break;
        default:
             clearAndRunSequence(sequenceName, [
                { message: `Running diagnostics for ${sequenceName}...`, delay: 1000, action: () => sendCommand(`DIAG_${sequenceName.toUpperCase().replace(' ', '_')}`) },
                { message: "Diagnostics complete.", delay: 2000 },
             ]);
            break;
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <Header
        connectionStatus={connectionStatus}
        ports={serialPorts}
        selectedPort={selectedPort}
        onPortChange={setSelectedPort}
        onConnect={handleConnect}
        isLogging={isLogging}
        onToggleLogging={handleLoggingToggle}
      />
      <main className="flex-grow p-4 md:p-6 lg:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
          <div className="lg:col-span-12">
            <SensorPanel data={sensorData} />
          </div>

          <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* --- 6. 밸브 패널과 함께 모터 패널 렌더링 --- */}
            <ValveControlPanel valves={valves} onValveChange={handleValveChange} />
            {motors.length > 0 && (
              <MotorControlPanel 
                motors={motors} 
                onAngleChange={handleMotorAngleChange} 
              />
            )}
            {/* 차트가 전체 너비를 차지하도록 레이아웃 수정 */}
            <div className="md:col-span-2">
              <DataChartPanel data={chartData} />
            </div>
          </div>

          <div className="lg:col-span-4 grid grid-cols-1 gap-6 auto-rows-min">
            <SequencePanel onSequence={handleSequence} activeSequence={activeSequence} />
            <TerminalPanel logs={sequenceLogs} activeSequence={activeSequence} />
          </div>

        </div>
      </main>
    </div>
  );
}
