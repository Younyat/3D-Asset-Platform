import * as THREE from 'three';

const stage = document.querySelector('three-d-stage');
const { THREE: T } = await stage.ready;
const deg = T.MathUtils.degToRad;

/* ---------------- materiales ---------------- */
const matSteel  = new T.MeshStandardMaterial({ name: 'steel_housing',  color: 0x454b52, roughness: 0.5,  metalness: 0.4 });
const matOrange = new T.MeshStandardMaterial({ name: 'safety_orange',  color: 0xd9520c, roughness: 0.42, metalness: 0.18 });
const matChrome = new T.MeshStandardMaterial({ name: 'chrome_joint',   color: 0xcfd2d6, roughness: 0.22, metalness: 0.8 });
const matRubber = new T.MeshStandardMaterial({ name: 'cable_rubber',   color: 0x1b1c1e, roughness: 0.85, metalness: 0.05 });
const matYellow = new T.MeshStandardMaterial({ name: 'warning_yellow', color: 0xe8b400, roughness: 0.5,  metalness: 0.1 });

const root = new T.Group();
root.name = 'IndustrialRobotArm';

/* ---------------- BASE fija ---------------- */
const base = new T.Group();
base.name = 'BASE_fixed';
root.add(base);

const basePlate = new T.Mesh(new T.CylinderGeometry(0.38, 0.42, 0.06, 48), matSteel);
basePlate.name = 'base_plate'; basePlate.position.y = 0.03; base.add(basePlate);

const pedestal = new T.Mesh(new T.CylinderGeometry(0.3, 0.34, 0.32, 48), matOrange);
pedestal.name = 'base_pedestal'; pedestal.position.y = 0.22; base.add(pedestal);

for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const bolt = new T.Mesh(new T.CylinderGeometry(0.02, 0.02, 0.04, 12), matChrome);
  bolt.name = `base_bolt_${i}`;
  bolt.position.set(Math.cos(a) * 0.36, 0.061, Math.sin(a) * 0.36);
  base.add(bolt);
}

const conduit = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([
  new T.Vector3(0.28, 0.08, 0.22), new T.Vector3(0.32, 0.22, 0.24), new T.Vector3(0.26, 0.36, 0.2),
]), 24, 0.028, 10, false), matRubber);
conduit.name = 'cable_conduit'; base.add(conduit);

/* ---------------- J1 · giro de torreta (Y) ---------------- */
const J1 = new T.Group(); J1.name = 'J1_base_yaw'; J1.position.y = 0.38; base.add(J1);

const turret = new T.Mesh(new T.CylinderGeometry(0.26, 0.28, 0.22, 48), matSteel);
turret.name = 'turret_body'; turret.position.y = 0.11; J1.add(turret);

const collar = new T.Mesh(new T.TorusGeometry(0.27, 0.025, 16, 48), matChrome);
collar.name = 'turret_collar'; collar.rotation.x = Math.PI / 2; J1.add(collar);

const shoulderHousing = new T.Mesh(new T.BoxGeometry(0.4, 0.34, 0.34), matOrange);
shoulderHousing.name = 'shoulder_housing'; shoulderHousing.position.set(0.02, 0.39, 0); J1.add(shoulderHousing);

/* ---------------- J2 · hombro (Z) ---------------- */
const J2 = new T.Group(); J2.name = 'J2_shoulder_pitch'; J2.position.set(0.02, 0.52, 0); J1.add(J2);

const shoulderAxle = new T.Mesh(new T.CylinderGeometry(0.16, 0.16, 0.44, 32), matChrome);
shoulderAxle.name = 'shoulder_axle'; shoulderAxle.rotation.x = Math.PI / 2; J2.add(shoulderAxle);

const L_UPPER = 0.62;
const upperArm = new T.Mesh(new T.BoxGeometry(0.22, L_UPPER, 0.26), matOrange);
upperArm.name = 'upper_arm'; upperArm.position.y = L_UPPER / 2; J2.add(upperArm);

const rib = new T.Mesh(new T.BoxGeometry(0.06, L_UPPER * 0.7, 0.06), matSteel);
rib.name = 'upper_arm_rib'; rib.position.set(0, L_UPPER / 2, 0.16); J2.add(rib);

const stripe = new T.Mesh(new T.BoxGeometry(0.225, 0.05, 0.265), matYellow);
stripe.name = 'upper_arm_stripe'; stripe.position.y = L_UPPER * 0.62; J2.add(stripe);

/* ---------------- J3 · codo (Z) ---------------- */
const J3 = new T.Group(); J3.name = 'J3_elbow_pitch'; J3.position.y = L_UPPER; J2.add(J3);

const elbowAxle = new T.Mesh(new T.CylinderGeometry(0.135, 0.135, 0.34, 32), matChrome);
elbowAxle.name = 'elbow_axle'; elbowAxle.rotation.x = Math.PI / 2; J3.add(elbowAxle);

const L_FORE = 0.46;
const forearm = new T.Mesh(new T.BoxGeometry(0.17, L_FORE, 0.19), matOrange);
forearm.name = 'forearm'; forearm.position.y = L_FORE / 2; J3.add(forearm);

const foreMotor = new T.Mesh(new T.CylinderGeometry(0.1, 0.1, 0.16, 32), matSteel);
foreMotor.name = 'forearm_motor_housing'; foreMotor.position.y = L_FORE * 0.32;
foreMotor.rotation.x = Math.PI / 2; J3.add(foreMotor);

/* ---------------- J4 · muñeca, cabeceo (Z) ---------------- */
const J4 = new T.Group(); J4.name = 'J4_wrist_pitch'; J4.position.y = L_FORE; J3.add(J4);

const wristBall = new T.Mesh(new T.SphereGeometry(0.1, 32, 24), matChrome);
wristBall.name = 'wrist_ball'; J4.add(wristBall);

const L_WRIST = 0.14;
const wristLink = new T.Mesh(new T.CylinderGeometry(0.07, 0.08, L_WRIST, 32), matSteel);
wristLink.name = 'wrist_link'; wristLink.position.y = L_WRIST / 2; J4.add(wristLink);

/* ---------------- J5 · giro de herramienta (Y) ---------------- */
const J5 = new T.Group(); J5.name = 'J5_tool_roll'; J5.position.y = L_WRIST; J4.add(J5);

const flange = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 0.03, 32), matChrome);
flange.name = 'tool_flange'; flange.position.y = 0.015; J5.add(flange);

const gripperBody = new T.Mesh(new T.BoxGeometry(0.18, 0.09, 0.14), matSteel);
gripperBody.name = 'gripper_body'; gripperBody.position.y = 0.075; J5.add(gripperBody);

/* ---------------- J6 · pinza (traslación X, ±) ---------------- */
const GRIP_OPEN = 0.085, GRIP_CLOSED = 0.032, L_FINGER = 0.18;
const fingers = {};
[['L', -1], ['R', 1]].forEach(([tag, side]) => {
  const g = new T.Group();
  g.name = `J6_gripper_finger_${tag}`;
  g.position.set(side * GRIP_OPEN, 0.12, 0);
  J5.add(g);
  fingers[tag] = { node: g, side };

  const finger = new T.Mesh(new T.BoxGeometry(0.045, L_FINGER, 0.09), matSteel);
  finger.name = `gripper_finger_${tag}`; finger.position.y = L_FINGER / 2; g.add(finger);

  const pad = new T.Mesh(new T.BoxGeometry(0.016, 0.07, 0.1), matRubber);
  pad.name = `gripper_pad_${tag}`; pad.position.set(-side * 0.026, L_FINGER - 0.04, 0); g.add(pad);
});

/* ================= RIG · definición de ejes ================= */
const RIG = [
  { id: 'J1', node: J1, name: 'J1_base_yaw',       axis: 'y', label: 'J1 · Giro base',      min: -170, max: 170, speed: 180, home: 0 },
  { id: 'J2', node: J2, name: 'J2_shoulder_pitch', axis: 'z', label: 'J2 · Hombro',         min: -60,  max: 95,  speed: 140, home: -10 },
  { id: 'J3', node: J3, name: 'J3_elbow_pitch',    axis: 'z', label: 'J3 · Codo',           min: -20,  max: 150, speed: 160, home: 60 },
  { id: 'J4', node: J4, name: 'J4_wrist_pitch',    axis: 'z', label: 'J4 · Muñeca',         min: -110, max: 110, speed: 250, home: 60 },
  { id: 'J5', node: J5, name: 'J5_tool_roll',      axis: 'y', label: 'J5 · Giro herram.',   min: -180, max: 180, speed: 320, home: 0 },
];

const setJoint = (j, degrees) => {
  const v = T.MathUtils.clamp(degrees, j.min, j.max);
  j.node.rotation[j.axis] = deg(v);
  return v;
};
const setGrip = (t) => { // t: 1 = abierta, 0 = cerrada
  const x = GRIP_CLOSED + (GRIP_OPEN - GRIP_CLOSED) * T.MathUtils.clamp(t, 0, 1);
  fingers.L.node.position.x = -x;
  fingers.R.node.position.x = x;
};

/* ================= CLIPS DE ANIMACIÓN ================= */
// Cada pose: { t, J1, J2, J3, J4, J5, grip }  (grados; grip 1=abierta 0=cerrada)
const CICLO = [
  { t: 0.0,  J1: 0,   J2: -10, J3: 60, J4: 60, J5: 0,  grip: 1 },
  { t: 1.5,  J1: -40, J2: 50,  J3: 70, J4: 60, J5: 0,  grip: 1 },
  { t: 2.6,  J1: -40, J2: 70,  J3: 70, J4: 40, J5: 0,  grip: 1 },
  { t: 3.3,  J1: -40, J2: 70,  J3: 70, J4: 40, J5: 0,  grip: 0 },
  { t: 4.2,  J1: -40, J2: 50,  J3: 70, J4: 60, J5: 0,  grip: 0 },
  { t: 5.8,  J1: 55,  J2: 50,  J3: 70, J4: 60, J5: 90, grip: 0 },
  { t: 6.9,  J1: 55,  J2: 70,  J3: 70, J4: 40, J5: 90, grip: 0 },
  { t: 7.6,  J1: 55,  J2: 70,  J3: 70, J4: 40, J5: 90, grip: 1 },
  { t: 8.5,  J1: 55,  J2: 50,  J3: 70, J4: 60, J5: 90, grip: 1 },
  { t: 10.0, J1: 0,   J2: -10, J3: 60, J4: 60, J5: 0,  grip: 1 },
];

const HOME = [
  { t: 0.0, J1: 0, J2: 20,  J3: 90, J4: 40, J5: 0, grip: 0 },
  { t: 2.0, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
];

// Recorrido de verificación: cada eje barre su rango, la pinza al final.
const DEMO = [
  { t: 0.0,  J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 1.6,  J1: -170, J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 4.0,  J1: 170,  J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 5.4,  J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 6.6,  J1: 0,    J2: 95,  J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 7.8,  J1: 0,    J2: -60, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 8.8,  J1: 0,    J2: -10, J3: 150, J4: 60,   J5: 0,    grip: 1 },
  { t: 9.8,  J1: 0,    J2: -10, J3: -20, J4: 60,   J5: 0,    grip: 1 },
  { t: 10.8, J1: 0,    J2: -10, J3: 60,  J4: 110,  J5: 0,    grip: 1 },
  { t: 11.8, J1: 0,    J2: -10, J3: 60,  J4: -110, J5: 0,    grip: 1 },
  { t: 12.8, J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: 180,  grip: 1 },
  { t: 13.8, J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: -180, grip: 1 },
  { t: 14.6, J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
  { t: 15.4, J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 0 },
  { t: 16.2, J1: 0,    J2: -10, J3: 60,  J4: 60,   J5: 0,    grip: 1 },
];

function buildClip(name, poses) {
  const times = poses.map((p) => p.t);
  const tracks = [];
  const q = new T.Quaternion(), e = new T.Euler();

  for (const j of RIG) {
    const values = [];
    for (const p of poses) {
      const a = deg(T.MathUtils.clamp(p[j.id], j.min, j.max));
      e.set(j.axis === 'x' ? a : 0, j.axis === 'y' ? a : 0, j.axis === 'z' ? a : 0);
      q.setFromEuler(e);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new T.QuaternionKeyframeTrack(`${j.name}.quaternion`, times, values));
  }

  for (const tag of ['L', 'R']) {
    const { node, side } = fingers[tag];
    const values = [];
    for (const p of poses) {
      const x = GRIP_CLOSED + (GRIP_OPEN - GRIP_CLOSED) * p.grip;
      values.push(side * x, node.position.y, 0);
    }
    tracks.push(new T.VectorKeyframeTrack(`J6_gripper_finger_${tag}.position`, times, values));
  }

  const clip = new T.AnimationClip(name, times[times.length - 1], tracks);
  return clip;
}

const clips = [
  buildClip('Ciclo_Pick_And_Place', CICLO),
  buildClip('Ir_A_Home', HOME),
  buildClip('Demo_Ejes', DEMO),
];
root.animations = clips;

/* Metadatos exportados como `extras` en el glTF: la otra plataforma
   puede leer límites, ejes y unidades directamente del archivo. */
root.userData = {
  schema: 'robot-arm-rig/1.0',
  units: 'meters',
  up: 'Y',
  toolFrame: 'J5_tool_roll',
  gripper: { type: 'parallel_2_finger', axis: 'X', openMeters: GRIP_OPEN, closedMeters: GRIP_CLOSED, strokeMeters: (GRIP_OPEN - GRIP_CLOSED) * 2 },
  joints: RIG.map((j) => ({
    name: j.name, order: j.id, type: 'revolute', axis: j.axis.toUpperCase(),
    limitsDeg: [j.min, j.max], maxSpeedDegPerSec: j.speed, homeDeg: j.home,
  })).concat([
    { name: 'J6_gripper_finger_L', order: 'J6', type: 'prismatic', axis: 'X', limitsMeters: [-GRIP_OPEN, -GRIP_CLOSED] },
    { name: 'J6_gripper_finger_R', order: 'J6', type: 'prismatic', axis: 'X', limitsMeters: [GRIP_CLOSED, GRIP_OPEN] },
  ]),
  clips: clips.map((c) => ({ name: c.name, durationSec: +c.duration.toFixed(2), loop: c.name === 'Ciclo_Pick_And_Place' })),
};

stage.setObject(root);

/* ================= Reproducción + control manual ================= */
const mixer = new T.AnimationMixer(root);
const clock = new T.Clock();
let action = null, manual = false;

function play(name) {
  const clip = clips.find((c) => c.name === name);
  if (action) action.stop();
  action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(name === 'Ir_A_Home' ? T.LoopOnce : T.LoopRepeat, Infinity);
  action.clampWhenFinished = true;
  action.play();
  manual = false;
}

(function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (!manual) mixer.update(dt);
})();

/* --- panel de control --- */
const ui = document.getElementById('rig-ui');
const sliders = {};
RIG.forEach((j) => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${j.label}<span data-v>0°</span></label>`;
  const input = document.createElement('input');
  input.type = 'range'; input.min = j.min; input.max = j.max; input.step = 1; input.value = j.home;
  const out = row.querySelector('[data-v]');
  input.addEventListener('input', () => {
    manual = true;
    if (action) { action.stop(); action = null; }
    document.querySelectorAll('#rig-ui button.clip').forEach((b) => b.classList.remove('on'));
    const v = setJoint(j, +input.value);
    out.textContent = `${v}°`;
  });
  out.textContent = `${j.home}°`;
  row.appendChild(input);
  ui.querySelector('#joints').appendChild(row);
  sliders[j.id] = { input, out };
});

const gripRow = document.createElement('div');
gripRow.className = 'row';
gripRow.innerHTML = '<label>J6 · Pinza<span data-v>abierta</span></label>';
const gripInput = document.createElement('input');
gripInput.type = 'range'; gripInput.min = 0; gripInput.max = 100; gripInput.value = 100;
gripInput.addEventListener('input', () => {
  manual = true;
  if (action) { action.stop(); action = null; }
  document.querySelectorAll('#rig-ui button.clip').forEach((b) => b.classList.remove('on'));
  const t = +gripInput.value / 100;
  setGrip(t);
  gripRow.querySelector('[data-v]').textContent = t > 0.9 ? 'abierta' : t < 0.1 ? 'cerrada' : `${Math.round(t * 100)}%`;
});
gripRow.appendChild(gripInput);
ui.querySelector('#joints').appendChild(gripRow);

document.querySelectorAll('#rig-ui button.clip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#rig-ui button.clip').forEach((b) => b.classList.toggle('on', b === btn));
    play(btn.dataset.clip);
  });
});

RIG.forEach((j) => setJoint(j, j.home));
setGrip(1);
play('Ciclo_Pick_And_Place');
document.querySelector('#rig-ui button.clip[data-clip="Ciclo_Pick_And_Place"]').classList.add('on');
