# Imported Model Analysis

Local folder analyzed: `3d imported models`

## Audi R8

- Direct import candidates: `Models/Audi R8.fbx`, `Models/Audi R8.dae`
- Conversion-only sources: `Audi R8.blend`, `Audi R8- Studio Render Scene.blend`
- Observations:
  - FBX parses successfully.
  - It contains meshes/materials but no skeleton bones.
  - Articulation must be inferred from object names such as wheels, doors, hood or trunk if those parts are separated in the file.
  - The model is very dense, so it may be heavy in the browser.

## iRobot

- Direct import candidate: `OBJ_Robot.obj`
- Conversion-only source: `C4D_Robot.c4d`
- Observations:
  - OBJ parses successfully.
  - It has no skeleton bones, but object names expose mechanical axes:
    - `Axis_1`
    - `Axis_2`
    - `Axis_3`
    - `Axis_4`
    - `Axis_5`
    - `grasper_L`
    - `grasper_R`
  - This is a mechanical articulated model, not a skinned rig. The platform now treats named parts as articulations.

## Rmk3 Robot Arm

- Direct import candidate: `Rmk3.obj`
- Conversion-only source: `Rmk3.c4d`
- Observations:
  - OBJ parses successfully.
  - It has no skeleton bones, but object names expose mechanical axes and grippers:
    - `BASE__rotating`
    - `ARM__prime`
    - `ARM__second`
    - `ARM__rotating`
    - `HEAD__pith`
    - `HEAD__rotating`
    - `LEFT_GRIP`
    - `RIGHT_GRIP`
  - The platform now detects these as object-based articulation controls.

## Format Rules

- Supported direct import: `.glb`, `.fbx`, `.dae`, `.obj`
- Conversion required: `.blend`, `.c4d`
- Best format for reliable articulation: rigged `.glb` or `.fbx`
- Best fallback for mechanical models: `.obj` with separated/named parts

## IRAmk4v3

- Direct import candidate: `IRAmk4.3ds`
- Conversion-only sources:
  - `IRAmk4.max`
  - `IRAmk4.c4d`
  - `SW/*.SLDPRT`
  - `SW/IRAmk4.SLDASM`
- Observations:
  - The `.3ds` file parses successfully in the platform.
  - It is dense: about 164 meshes and over 2M vertices.
  - Original bounds are approximately `293 x 776 x 443`, so intelligent scale normalization is required.
  - The platform now imports it as a normalized `3DS` model and detects several mechanical articulation candidates from truncated names such as `BASE_ROT`.
  - For best CAD-quality articulation, export the SolidWorks assembly to FBX/GLB/OBJ with separated parts and meaningful object names.
