/**
 * RobotArmController — controlador de referencia del brazo robot industrial.
 *
 * Independiente del renderizador: solo necesita un objeto raiz cuya jerarquia
 * contenga los nodos con nombre del rig (J1_base_yaw … J6_gripper_finger_R) y
 * un modo de buscarlos por nombre. Con three.js funciona directamente.
 *
 *   import { RobotArmController } from './robot-controller.js';
 *
 *   const gltf = await new GLTFLoader().loadAsync('brazo-robot-industrial.glb');
 *   scene.add(gltf.scene);
 *
 *   const robot = new RobotArmController(gltf.scene, THREE, {
 *     animations: gltf.animations,   // opcional: habilita playClip()
 *   });
 *
 *   // A) reproducir una animacion incluida en el archivo
 *   robot.playClip('Ciclo_Pick_And_Place');
 *
 *   // B) control articulado con limite de velocidad
 *   robot.moveTo({ J1: 45, J2: 30, J3: 80, J4: 70 });
 *   robot.setGrip(0);              // 0 = cerrada, 1 = abierta
 *
 *   // C) secuencia completa de recogida y deposito
 *   robot.runSequence(robot.pickAndPlace({ pickYaw: -40, placeYaw: 55 }));
 *
 *   // en el bucle de render, SIEMPRE:
 *   robot.update(deltaSeconds);
 */

export const RIG = {
  J1: { name: 'J1_base_yaw',       axis: 'y', min: -170, max: 170, speed: 180, home: 0 },
  J2: { name: 'J2_shoulder_pitch', axis: 'z', min: -60,  max: 95,  speed: 140, home: -10 },
  J3: { name: 'J3_elbow_pitch',    axis: 'z', min: -20,  max: 150, speed: 160, home: 60 },
  J4: { name: 'J4_wrist_pitch',    axis: 'z', min: -110, max: 110, speed: 250, home: 60 },
  J5: { name: 'J5_tool_roll',      axis: 'y', min: -180, max: 180, speed: 320, home: 0 },
};

export const GRIP = {
  left: 'J6_gripper_finger_L',
  right: 'J6_gripper_finger_R',
  open: 0.085,
  closed: 0.032,
  speed: 0.12, // m/s
};

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class RobotArmController {
  /**
   * @param {object} root  nodo raiz del modelo importado (Object3D en three.js)
   * @param {object} THREE referencia a three.js (solo para playClip; opcional)
   * @param {object} opts  { animations }
   */
  constructor(root, THREE = null, opts = {}) {
    this.root = root;
    this.THREE = THREE;
    this.nodes = {};
    this.target = {};
    this.current = {};
    this.gripTarget = 1;
    this.gripCurrent = 1;
    this._queue = [];
    this._wait = 0;
    this.mixer = null;
    this.action = null;
    this.animations = opts.animations || root.animations || [];

    for (const key of Object.keys(RIG)) {
      const node = this._find(RIG[key].name);
      if (!node) throw new Error(`RobotArmController: falta el nodo "${RIG[key].name}". ` +
        'Comprueba que la importacion conserva los nombres de nodo del rig.');
      this.nodes[key] = node;
      this.current[key] = RIG[key].home;
      this.target[key] = RIG[key].home;
    }
    this.fingerL = this._find(GRIP.left);
    this.fingerR = this._find(GRIP.right);

    if (THREE && this.animations.length) this.mixer = new THREE.AnimationMixer(root);
    this.goHome(true);
  }

  _find(name) {
    if (this.root.getObjectByName) return this.root.getObjectByName(name);
    let found = null;
    this.root.traverse?.((o) => { if (o.name === name) found = o; });
    return found;
  }

  /* ---------- control directo (sin suavizado) ---------- */

  /** Escribe un angulo en grados, recortado a los limites del eje. */
  setJoint(key, degrees) {
    const j = RIG[key];
    const v = clamp(degrees, j.min, j.max);
    this.nodes[key].rotation[j.axis] = v * DEG;
    this.current[key] = v;
    this.target[key] = v;
    return v;
  }

  /** Pose completa inmediata: { J1..J5, grip }. */
  setPose(pose) {
    for (const key of Object.keys(RIG)) if (pose[key] !== undefined) this.setJoint(key, pose[key]);
    if (pose.grip !== undefined) this.setGrip(pose.grip, true);
  }

  /** t: 1 = abierta, 0 = cerrada. */
  setGrip(t, immediate = false) {
    this.gripTarget = clamp(t, 0, 1);
    if (immediate) this.gripCurrent = this.gripTarget;
    const x = GRIP.closed + (GRIP.open - GRIP.closed) * this.gripCurrent;
    if (this.fingerL) this.fingerL.position.x = -x;
    if (this.fingerR) this.fingerR.position.x = x;
  }

  /* ---------- control servo (con limite de velocidad) ---------- */

  /** Fija objetivos; update() los alcanza respetando maxSpeed de cada eje. */
  moveTo(pose) {
    for (const key of Object.keys(RIG)) {
      if (pose[key] !== undefined) this.target[key] = clamp(pose[key], RIG[key].min, RIG[key].max);
    }
    if (pose.grip !== undefined) this.gripTarget = clamp(pose.grip, 0, 1);
    this.stopClip();
    return this;
  }

  goHome(immediate = false) {
    const home = {};
    for (const key of Object.keys(RIG)) home[key] = RIG[key].home;
    home.grip = 1;
    if (immediate) this.setPose(home); else this.moveTo(home);
    return this;
  }

  /** true cuando todos los ejes y la pinza han alcanzado su objetivo. */
  isSettled(tolDeg = 0.5) {
    for (const key of Object.keys(RIG)) {
      if (Math.abs(this.target[key] - this.current[key]) > tolDeg) return false;
    }
    return Math.abs(this.gripTarget - this.gripCurrent) < 0.01;
  }

  /** Llamar una vez por frame con el delta en segundos. */
  update(dt) {
    if (this.mixer && this.action) { this.mixer.update(dt); return; }

    for (const key of Object.keys(RIG)) {
      const j = RIG[key];
      const step = j.speed * dt * this.speedScale;
      const delta = clamp(this.target[key] - this.current[key], -step, step);
      if (delta !== 0) {
        this.current[key] += delta;
        this.nodes[key].rotation[j.axis] = this.current[key] * DEG;
      }
    }
    const gripRange = GRIP.open - GRIP.closed;
    const gStep = (GRIP.speed * dt * this.speedScale) / gripRange;
    const gDelta = clamp(this.gripTarget - this.gripCurrent, -gStep, gStep);
    if (gDelta !== 0) { this.gripCurrent += gDelta; this.setGrip(this.gripTarget); }

    this._advanceQueue(dt);
  }

  speedScale = 1; // 0.5 = mitad de velocidad, 2 = doble

  /* ---------- secuencias ---------- */

  /**
   * Cola de pasos. Cada paso: { pose } | { grip } | { wait } | { call }
   * El siguiente paso arranca cuando el anterior ha terminado.
   */
  runSequence(steps) {
    this._queue = steps.slice();
    this._wait = 0;
    this._active = false;
    return this;
  }

  _advanceQueue(dt) {
    if (!this._queue.length) return;
    if (this._wait > 0) { this._wait -= dt; return; }
    if (this._active && !this.isSettled()) return;

    const step = this._queue.shift();
    this._active = false;
    if (step.wait !== undefined) { this._wait = step.wait; return; }
    if (step.call) { step.call(this); return; }
    if (step.pose) { this.moveTo(step.pose); this._active = true; return; }
    if (step.grip !== undefined) { this.gripTarget = clamp(step.grip, 0, 1); this._active = true; }
  }

  /**
   * Ciclo de recogida y deposito equivalente al clip Ciclo_Pick_And_Place,
   * pero generado en codigo (parametrizable).
   */
  pickAndPlace({ pickYaw = -40, placeYaw = 55, placeRoll = 90, onGrasp, onRelease } = {}) {
    const high = { J2: 50, J3: 70, J4: 60 };
    const low  = { J2: 70, J3: 70, J4: 40 };
    return [
      { pose: { J1: pickYaw, ...high, J5: 0, grip: 1 } },
      { pose: { J1: pickYaw, ...low } },
      { grip: 0 },
      { call: () => onGrasp && onGrasp() },   // emparentar la pieza a J5_tool_roll
      { pose: { J1: pickYaw, ...high } },
      { pose: { J1: placeYaw, ...high, J5: placeRoll } },
      { pose: { J1: placeYaw, ...low } },
      { grip: 1 },
      { call: () => onRelease && onRelease() }, // devolver la pieza a la escena
      { pose: { J1: placeYaw, ...high } },
      { call: (r) => r.goHome() },
    ];
  }

  /* ---------- clips incluidos en el archivo ---------- */

  playClip(name, { loop = true } = {}) {
    if (!this.mixer) throw new Error('playClip requiere three.js y gltf.animations');
    const THREE = this.THREE;
    const clip = THREE.AnimationClip.findByName(this.animations, name);
    if (!clip) throw new Error(`Clip "${name}" no encontrado. Disponibles: ` +
      this.animations.map((c) => c.name).join(', '));
    if (this.action) this.action.stop();
    this.action = this.mixer.clipAction(clip);
    this.action.reset();
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = true;
    this.action.play();
    this._queue = [];
    return this.action;
  }

  stopClip() {
    if (this.action) { this.action.stop(); this.action = null; }
    // sincroniza el estado servo con la pose real tras detener el clip
    for (const key of Object.keys(RIG)) {
      this.current[key] = this.nodes[key].rotation[RIG[key].axis] / DEG;
      this.target[key] = this.current[key];
    }
  }

  /** Diagnostico: informa de lo que la plataforma ha importado realmente. */
  diagnose() {
    const report = { nodesFound: {}, clips: this.animations.map((c) => `${c.name} (${c.duration.toFixed(1)}s)`) };
    for (const key of Object.keys(RIG)) report.nodesFound[RIG[key].name] = !!this.nodes[key];
    report.nodesFound[GRIP.left] = !!this.fingerL;
    report.nodesFound[GRIP.right] = !!this.fingerR;
    report.rigExtras = this.root.userData?.schema || 'ausente';
    return report;
  }
}

export { easeInOut, clamp };
