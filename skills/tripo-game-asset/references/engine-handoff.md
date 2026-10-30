# Export to a game engine

An animated Tripo character into Godot, Unity or Unreal, with a character controller: WASD or
arrows move relative to the camera, Shift runs, Space jumps, J attacks. The controllers find clips
by name, as the Desktop Play mode does (`idle`, `walk`, `run`, `jump`, `slash` ...).

A Tripo character usually faces +X (`export_orientation` defaults to `+x`), but one made from a
side view can face along Z: check in the 3D viewer which way the head points. It comes out one unit
on its longest side. The controllers below turn the model by its front, so leave
`export_orientation` at its default; set the size in the engine, or convert with `scale_factor` set
to the size in metres of its longest side (10 credits). Clips made with `animate_in_place: true` (the Make it playable default) stay
on the spot, which is what a controller expects.

## Engine plugins in Hermes

When `tool_search` finds tools from a community engine plugin (for example godot-studio,
game-editor, csharp-game-editor or unreal-mcp), hand the work to it: give it the downloaded file and
the controller below, and let it place the character in a scene and run it. Without one, write the
files into the project and tell the user the steps left in the editor.

## Godot 4 (free: the GLB as it is)

1. `tripo_download` the animation task with `output_dir` set to a folder of the project (e.g.
   `<project>/characters/dragon`). Godot imports the GLB with an `AnimationPlayer` holding the clips.
2. Put `player.gd` and `player.tscn` below in that folder; point the `Model` instance in
   `player.tscn` at the downloaded GLB and instance the scene in a level with a floor that has
   collision.
3. Scale the `Model` node to the character's real height and resize the capsule to match.

`player.gd`:

```gdscript
extends CharacterBody3D
# Third-person controller for an animated Tripo character: WASD or arrows move relative to the camera, Shift runs,
# Space jumps, J attacks, right-drag turns the camera. Clips are found by name.

@export var walk_speed := 2.0
@export var run_speed := 5.0
@export var jump_velocity := 4.5
const MODEL_YAW := -PI / 2  # the model's front: -PI / 2 when it faces +X, 0 for +Z, PI for -Z, PI / 2 for -X

@onready var model: Node3D = $Model
@onready var arm: SpringArm3D = $CameraArm
@onready var anim: AnimationPlayer = model.find_child("AnimationPlayer", true, false)
@onready var idle := clip(["idle", "stand", "breath"])
@onready var walk := clip(["walk", "march", "crawl", "swim"])
@onready var run := clip(["run", "sprint", "gallop"])
@onready var jump := clip(["jump", "leap"])
@onready var attack := clip(["slash", "attack", "shoot", "punch", "kick", "bite", "strike"])
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")
var attacking := 0.0


func clip(words: Array) -> String:
	for found in anim.get_animation_list():
		for word in words:
			if word in found.to_lower():
				return found
	return ""


func held(keys: Array) -> bool:
	for key in keys:
		if Input.is_physical_key_pressed(key):
			return true
	return false


func _ready() -> void:
	arm.add_excluded_object(get_rid())
	for looped in [idle, walk, run]:
		if looped != "":
			anim.get_animation(looped).loop_mode = Animation.LOOP_LINEAR


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.physical_keycode == KEY_J:
		if attack != "" and attacking <= 0.0:
			attacking = anim.get_animation(attack).length
			anim.play(attack, 0.1)
	elif event is InputEventMouseMotion and Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT):
		arm.rotation.y -= event.relative.x * 0.005
		arm.rotation.x = clamp(arm.rotation.x - event.relative.y * 0.005, -1.2, 0.3)


func _physics_process(delta: float) -> void:
	var ahead := float(held([KEY_W, KEY_UP])) - float(held([KEY_S, KEY_DOWN]))
	var aside := float(held([KEY_D, KEY_RIGHT])) - float(held([KEY_A, KEY_LEFT]))
	var running := held([KEY_SHIFT])
	var view := arm.global_transform.basis
	var move := (Vector3(-view.z.x, 0, -view.z.z).normalized() * ahead + Vector3(view.x.x, 0, view.x.z).normalized() * aside).normalized()
	attacking -= delta
	if attacking > 0.0:
		move = Vector3.ZERO  # an attack roots the character
	var speed := run_speed if running else walk_speed
	velocity.x = move.x * speed
	velocity.z = move.z * speed
	if is_on_floor():
		if held([KEY_SPACE]):
			velocity.y = jump_velocity
	else:
		velocity.y -= gravity * delta
	move_and_slide()
	if move != Vector3.ZERO:
		model.rotation.y = lerp_angle(model.rotation.y, atan2(move.x, move.z) + MODEL_YAW, 12.0 * delta)

	var want := idle
	if attacking > 0.0:
		want = attack
	elif not is_on_floor() and jump != "":
		want = jump
	elif move != Vector3.ZERO:
		want = run if running and run != "" else walk
	if want == "":
		if anim.is_playing():
			anim.stop()  # no idle clip: hold the first frame of the last clip
	elif anim.current_animation != want:
		anim.play(want, 0.2)
	anim.speed_scale = 1.6 if want == walk and running and run == "" else 1.0
```

`player.tscn` (change both paths; the capsule fits a character one unit tall):

```
[gd_scene load_steps=4 format=3]

[ext_resource type="Script" path="res://characters/dragon/player.gd" id="1_script"]
[ext_resource type="PackedScene" path="res://characters/dragon/model.glb" id="2_model"]

[sub_resource type="CapsuleShape3D" id="Capsule"]
radius = 0.25
height = 1.0

[node name="Player" type="CharacterBody3D"]
script = ExtResource("1_script")

[node name="Model" parent="." instance=ExtResource("2_model")]

[node name="Collision" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0)
shape = SubResource("Capsule")

[node name="CameraArm" type="SpringArm3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9397, 0.342, 0, -0.342, 0.9397, 0, 0.8, 0)
spring_length = 3.0

[node name="Camera" type="Camera3D" parent="CameraArm"]
```

## Unity

1. Rig a biped with `spec: "unity"` (Unity Humanoid bone names), then `tripo_convert`
   `{input: <animation task>, format: "FBX"}` (5 credits; 10 with options such as `scale_factor`),
   or `out_format: "fbx"` on rig and animate when Unity is known up front. `tripo_download` it
   into `Assets/`.
2. Import settings: Rig → Animation Type **Humanoid** (**Generic** for a creature), Avatar
   Definition "Create From This Model".
   Animation → **Loop Time** on for idle, walk and run; Root Transform Rotation, Position (Y) and
   Position (XZ) **Bake Into Pose**. Apply.
3. An empty `Player` object with a **CharacterController** sized to the model, the model as its
   child, and the script below on `Player`; drag the clips from the FBX onto its fields. Any follow
   camera works (Cinemachine or a child camera); moves are relative to the main camera. For a
   creature (Generic), turn the model child by hand so its head points along `Player`'s blue
   (forward) axis.

`PlayableCharacter.cs` (clips through a PlayableGraph, so no Animator Controller asset; it works
with either input system):

```csharp
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

// Third-person controller for an animated Tripo character: WASD or arrows move relative to the main camera, Shift
// runs, Space jumps, J attacks.
[RequireComponent(typeof(CharacterController))]
public class PlayableCharacter : MonoBehaviour
{
    public AnimationClip idle, walk, run, jump, attack;
    public float walkSpeed = 2f, runSpeed = 5f, jumpSpeed = 4.5f, turnSpeed = 720f;

    CharacterController body;
    PlayableGraph graph;
    AnimationMixerPlayable mixer;
    AnimationClip[] clips;
    float[] weights;
    float fall, attacking;

    void Start()
    {
        body = GetComponent<CharacterController>();
        var animator = GetComponentInChildren<Animator>();
        animator.applyRootMotion = false;
        // Turn the model so its front, found from its legs, is this object's forward (Humanoid rigs only).
        Transform l = animator.GetBoneTransform(HumanBodyBones.LeftUpperLeg), r = animator.GetBoneTransform(HumanBodyBones.RightUpperLeg);
        if (l && r)
            animator.transform.Rotate(Vector3.up, Vector3.SignedAngle(Vector3.Cross(r.position - l.position, Vector3.up), transform.forward, Vector3.up), Space.World);

        clips = new[] { idle, walk, run, jump, attack };
        weights = new float[clips.Length];
        graph = PlayableGraph.Create(name);
        mixer = AnimationMixerPlayable.Create(graph, clips.Length);
        for (int i = 0; i < clips.Length; i++)
        {
            var clip = clips[i] ? clips[i] : i == 0 ? walk : null; // no idle clip: hold the walk's first frame
            if (!clip) continue;
            var playable = AnimationClipPlayable.Create(graph, clip);
            if (clip != clips[i]) playable.SetSpeed(0);
            graph.Connect(playable, 0, mixer, i);
        }
        AnimationPlayableOutput.Create(graph, "Animation", animator).SetSourcePlayable(mixer);
        graph.Play();
    }

    void Update()
    {
        var view = Camera.main ? Camera.main.transform : transform;
        Vector3 forward = Vector3.ProjectOnPlane(view.forward, Vector3.up).normalized;
        Vector3 right = Vector3.ProjectOnPlane(view.right, Vector3.up).normalized;
        float ahead = (Held(KeyCode.W) || Held(KeyCode.UpArrow) ? 1 : 0) - (Held(KeyCode.S) || Held(KeyCode.DownArrow) ? 1 : 0);
        float aside = (Held(KeyCode.D) || Held(KeyCode.RightArrow) ? 1 : 0) - (Held(KeyCode.A) || Held(KeyCode.LeftArrow) ? 1 : 0);
        Vector3 move = Vector3.ClampMagnitude(forward * ahead + right * aside, 1f);
        bool running = Held(KeyCode.LeftShift);

        attacking -= Time.deltaTime;
        if (attack && attacking <= 0f && Pressed(KeyCode.J))
        {
            attacking = attack.length;
            mixer.GetInput(4).SetTime(0);
        }
        if (attacking > 0f) move = Vector3.zero; // an attack roots the character
        if (body.isGrounded)
        {
            fall = -1f;
            if (Pressed(KeyCode.Space))
            {
                fall = jumpSpeed;
                if (jump) mixer.GetInput(3).SetTime(0);
            }
        }
        fall += Physics.gravity.y * Time.deltaTime;
        body.Move((move * (running ? runSpeed : walkSpeed) + Vector3.up * fall) * Time.deltaTime);
        if (move.sqrMagnitude > 0.01f)
            transform.rotation = Quaternion.RotateTowards(transform.rotation, Quaternion.LookRotation(move), turnSpeed * Time.deltaTime);

        int want = attacking > 0f ? 4 : !body.isGrounded && jump ? 3 : move.sqrMagnitude > 0.01f ? (running && run ? 2 : 1) : 0;
        for (int i = 0; i < clips.Length; i++)
        {
            weights[i] = Mathf.MoveTowards(weights[i], i == want ? 1f : 0f, Time.deltaTime / 0.2f);
            mixer.SetInputWeight(i, weights[i]);
        }
        if (walk) mixer.GetInput(1).SetSpeed(want == 1 && running && !run ? 1.6f : 1f);
    }

    void OnDestroy()
    {
        if (graph.IsValid()) graph.Destroy();
    }

#if ENABLE_INPUT_SYSTEM && !ENABLE_LEGACY_INPUT_MANAGER
    // The Input System's Key enum names these keys as KeyCode does.
    static UnityEngine.InputSystem.Controls.KeyControl Control(KeyCode key) =>
        UnityEngine.InputSystem.Keyboard.current?[System.Enum.Parse<UnityEngine.InputSystem.Key>(key.ToString())];
    static bool Held(KeyCode key) => Control(key)?.isPressed ?? false;
    static bool Pressed(KeyCode key) => Control(key)?.wasPressedThisFrame ?? false;
#else
    static bool Held(KeyCode key) => Input.GetKey(key);
    static bool Pressed(KeyCode key) => Input.GetKeyDown(key);
#endif
}
```

## Unreal Engine 5 (no code: the Third Person template controls it)

1. Rig with `spec: "unreal"` (UE Mannequin bone names), then `tripo_convert`
   `{input: <animation task>, format: "FBX"}` (5 credits), or `out_format: "fbx"` on rig and
   animate when Unreal is known up front. Download it where the user imports from.
2. In a Third Person project (Unreal's template), import the FBX as a Skeletal Mesh with its
   animations. With UE Mannequin bone names, pick the template's mannequin skeleton in the import
   dialog so the template's animations play on it directly; when Unreal refuses that skeleton,
   import with its own and retarget the template's animations with an IK Retargeter.
3. In `BP_ThirdPersonCharacter`, set the Mesh component's Skeletal Mesh to the character and its
   Anim Class to the template's (or the retargeted) Animation Blueprint, then turn and lower the
   mesh in the component until it faces the arrow and stands on the capsule's bottom. If it comes in
   tiny, raise the import's uniform scale or convert with a `scale_factor`.
