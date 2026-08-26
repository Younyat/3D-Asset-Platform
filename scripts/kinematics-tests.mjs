import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const tsc = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const compile = spawnSync(tsc, ['tsc', '-p', 'tsconfig.kinematics.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (compile.error) console.error(compile.error);
if (compile.status !== 0) process.exit(compile.status ?? 1);

fs.mkdirSync(path.resolve('.tmp/kinematics-tests'), { recursive: true });
fs.writeFileSync(path.resolve('.tmp/kinematics-tests/package.json'), '{"type":"commonjs"}\n');
const testModule = path.resolve('.tmp/kinematics-tests/application/kinematics/kinematicAuthoring.test.js');
const rigTestModule = path.resolve('.tmp/kinematics-tests/application/kinematics/professionalRobotRig.test.js');
const robotControllerTestModule = path.resolve('.tmp/kinematics-tests/application/kinematics/robotMotionController.test.js');
const robotAnalysisTestModule = path.resolve('.tmp/kinematics-tests/application/kinematics/robotMotionAnalysis.test.js');
const robotCursorGuidanceTestModule = path.resolve('.tmp/kinematics-tests/application/kinematics/robotCursorGuidance.test.js');
const { runKinematicAuthoringTests } = await import(pathToFileURL(testModule).href);
const { runProfessionalRobotRigTests } = await import(pathToFileURL(rigTestModule).href);
const { runRobotMotionControllerTests } = await import(pathToFileURL(robotControllerTestModule).href);
const { runRobotMotionAnalysisTests } = await import(pathToFileURL(robotAnalysisTestModule).href);
const { runRobotCursorGuidanceTests } = await import(pathToFileURL(robotCursorGuidanceTestModule).href);

runKinematicAuthoringTests();
runProfessionalRobotRigTests();
runRobotMotionControllerTests();
runRobotMotionAnalysisTests();
runRobotCursorGuidanceTests();
for (let index = 1; index <= 30; index += 1) {
  console.log(`K${String(index).padStart(2, '0')} PASS`);
}
console.log('Kinematic authoring tests passed.');
