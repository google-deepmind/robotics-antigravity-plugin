---
name: mujoco-audit
description: >-
  Audits, validates, and remediates MuJoCo 3D assets (MJCF model.xml, .mjz
  archives, or mjSpec models) using the 7-point static/PBR/mesh hygiene checker
  (--static_only), the 10-scenario physical test suite (audit_scenarios.py with
  --scenarios and --thresholds_json), and Before-vs-After comparison sheets. Use
  only when the user explicitly names MuJoCo, MJCF, .mjz, or mjSpec to audit,
  validate, or fix a MuJoCo asset. Don't use for non-MuJoCo 3D mesh/CAD/USD
  linters.
metadata:
  publisher: google
---

# MuJoCo Asset Audit, Verification & Remediation Skill

Use this skill whenever you need to **audit, triage, validate, or remediate** a
MuJoCo MJCF asset (`model.xml` or `.mjz` archive)—whether running a read-only
diagnostic check, performing a fast or deep remediation of an existing asset, or
verifying a newly created asset from
[`blender-creation/SKILL.md`](../blender-creation/SKILL.md).

For the canonical MJCF authoring rules referenced below (§1–§8: coordinate
frames, naming, groups `2`/`3`/`4`, hand-authored convex hulls & analytic
primitives vs. `coacd` fallback, mass/inertia, contacts/joints, and PBR
materials), consult [`rules/mujoco_asset_standards.md`][asset-standards].

> [!IMPORTANT]
>
> **Protect Your Context Window**:
> * Read **only this `mujoco-audit/SKILL.md` upfront** (`1` `read_file` call). Do **NOT** read all of [`rules/mujoco_asset_standards.md`][asset-standards] upfront—first run `audit_scenarios.py` (§2) and consult [`rules/mujoco_asset_standards.md`][asset-standards] **only on demand** for the specific section(s) that fail.
> * Do **NOT** read the `.py` implementation source of [`scripts/audit_scenarios.py`](scripts/audit_scenarios.py) or [`../mujoco-showcase-shot/scripts/render_showcase_shot.py`](../mujoco-showcase-shot/scripts/render_showcase_shot.py)—all CLI flags and Python return schemas are documented below.

--------------------------------------------------------------------------------

## 0. Subagent Orchestration & Audit Configuration

### Canonical User Prompt Template

Users invoke this skill with the **Zero-Jump, Paste-at-the-End** configuration
block (all defaults are pre-filled above; the user pastes their target asset
path and any optional notes on the last line, and any overrides written on that
last line take precedence over the defaults above):

```markdown
Audit and remediate MuJoCo MJCF asset using mujoco-audit:
- Action: Audit & Fix        # or: Read-Only Triage
- Depth: Full                # or: Fast
- Articulations: Keep        # or: Rigid-Only | Skip Passive Variant
Target(s) & optional notes:
```

### Orchestration Rules (Parent Conversation vs. Worker Subagent)

1.  **If you are the top-level / parent conversation**:

    *   Spawn a `self` subagent (`Model: "inherit"`) via `invoke_subagent` to
        execute this skill on the target asset(s), passing all user-specified
        knobs (`Action`, `Depth`, `Articulations`, `Passive Mechanism Variant`,
        and `Known Issues / Custom Focus`), your
        `Parent Conversation ID: <parent_conv_id>`, and instructing the subagent
        to read this `mujoco-audit/SKILL.md` first (consulting
        [`rules/mujoco_asset_standards.md`][asset-standards] only on demand if a check
        fails).
    *   **When the subagent finishes**: Present the remediated asset path (or
        triage verdict), a concise summary of the findings/fixes, and the
        verification renders/videos to the user.

2.  **If you are already the spawned subagent (or running inside a Blender
    creation check)**:

    *   Do **not** spawn a nested subagent—execute the audit/remediation
        directly.
    *   **Scratch Hygiene**: Place all temporary scripts and intermediate files
        in `<ArtifactDir>/scratch/` (never inside the repository working tree).

--------------------------------------------------------------------------------

## 1. Prompt-Knob Mapping & Pathway Selection

**Do not treat every audit as a one-size-fits-all pipeline.** Map the user's
prompt options (or natural-language instructions) directly to your execution:

*   **`Action`**:
    *   **`Audit & Fix`** *(default)*: Diagnose all static and dynamic defects,
        remediate the asset in place (or in the requested output directory),
        verify the fix by re-running `audit_scenarios.py`, and render Before vs.
        After comparison panels.
    *   **`Read-Only Triage`**: **Do not modify any asset files.** Run
        `audit_scenarios.py`, inspect both the `.json` scorecard and `.png`
        contact sheet alongside `model.xml`, and return a structured report
        stating: (1) Overall verdict (`PASS / Clean` vs. `NEEDS REMEDIATION`),
        (2) True modeling/physics defects, and (3) Disregarded
        geometry-expected flags.
*   **`Depth`**:
    *   **`Full`** *(default)*: Evaluate all 7 static criteria (§3), run **all
        10 physics scenarios (`--scenarios=all`)** Before and After remediation
        (plus any custom `MjSpec` mechanism probes via `uv run`), render a
        6-view visual/collision inspection sheet + Before vs. After comparison
        sheet, and (when `Action == Audit & Fix`) render a 360° Filament PBR
        turntable video via
        [`mujoco-showcase-shot/SKILL.md`](../mujoco-showcase-shot/SKILL.md).
    *   **`Fast`**: Prioritize speed and minimal iterations. Check the 7 static
        criteria (§3, or run `--static_only` for an instant `<0.5s` check) and
        run **only the 1–3 scenarios matching the object's geometry** via
        `--scenarios=...` (e.g., `--scenarios=1,3` for a solid prop,
        `--scenarios=1,4` for a container/loop, `--scenarios=1,6` for a hinged
        tool) so simulation finishes in `~1–2 s`. Render a single Before vs.
        After visual & collision overlay sheet, and **skip** `_mechanical`
        variants and **skip** `showcase_shot` turntable videos.
*   **`Articulations`**:
    *   **`Keep / Upgrade`** *(default)*: Preserve/fix existing joints, or split
        welded movable parts (drawers, doors, hinges, casters) into articulated
        child bodies per [`rules/mujoco_asset_standards.md`][asset-standards] §7.2.
    *   **`Rigid-Only (0 DoF)`**: Treat the asset as a single rigid body (`0`
        internal DoF). Consolidate/bake any internal child bodies or unwanted
        joints into the single root `<body name="<asset_name>">` at
        `pos="0 0 0" quat="1 0 0 0"` while preserving world-space geom poses.
        Skip Scenario 6 and skip `<asset_name>_mechanical/`.
*   **`Passive Mechanism Variant`**:
    *   **`Auto`** *(default)*: If the object has an important coupled passive
        mechanism (ratchet, release trigger, spring clutch) and `Depth != Fast`
        and `Articulations != Rigid-Only`, keep the clean direct-joint baseline
        in `<asset_name>/` and create `<asset_name>_mechanical/` per
        [`rules/mujoco_asset_standards.md`][asset-standards] §7.2.
    *   **`Skip`**: Only build/remediate the primary `<asset_name>/` bundle.
*   **`Known Issues / Custom Focus`**:
    *   Whenever the user specifies a symptom, target mass/dimension, or focus
        area (e.g., *"tongs don't pinch"*, *"hollow out mug"*), prioritize
        running the matching scenario(s) (`--scenarios=6`, `--scenarios=4`,
        etc.) and writing a targeted `MjSpec` probe for that exact requirement
        first.

> **CRITICAL — Two-Tier Telemetry (`FAIL` vs. `INFO`) & Engineering Judgment**:
> [`scripts/audit_scenarios.py`](scripts/audit_scenarios.py) uses a strict
> two-tier design:
>
> *   **Tier 1 — Genuine Unconditional `FAIL`s**: Only emit `FAIL` (or
>     `passed=False`) for unambiguous simulation/structural bugs: `NaN`/`Inf`
>     instability, high-speed thin-slab tunneling (`Scenario 10`), severe
>     resting hover or floor sink (`> max(3 mm, 3% min_span)` in `Scenario 1`),
>     missing component colliders or gross frame/scale mismatch
>     (`collision_alignment`), static XML/PBR/UV errors
>     (`static_and_mesh_hygiene`), compile-time `maxhullvert="64"` vertex
>     truncation (`maxhullvert_truncated_geoms`), broken articulation mechanics
>     (`Scenario 6`), or `<site>`s placed in collision `group="3"`
>     (`Scenario 9`).
> *   **Tier 2 — Diagnostic `INFO` Telemetry (Interpret with Physical
>     Intuition)**: Context-dependent metrics (`c2v`/`v2c` millimeter
>     percentiles, `z_band_mass_density`, `com_height_pct_of_z_span`,
>     `hull_density_cv`, tilt slip/tip angles, roll settle time, cavity/ray
>     counts, grasp slip, cliff overhang %, and twin self-stack ratio) are
>     reported with `status: "INFO"` so you evaluate them against the object's
>     real-world geometry and materials rather than gaming arbitrary pass/fail
>     cutoffs:
>     *   **Multi-material & composite objects** (e.g., a potted plant with a
>         dense pot base and airy upper foliage hulls, a weighted lamp, or a
>         metal-head tool with a plastic handle): Inspect `z_band_mass_density`
>         (`lower_third`, `mid_third`, `upper_third`) and
>         `com_height_pct_of_z_span` in `asset_info` / `Scenario 3`, and assign
>         physically realistic per-region densities (so `CoM_z` sits inside the
>         weighted base/pot) rather than forcing `hull_density_cv = 0` across
>         disparate materials.
>     *   **Clean semantic convex hulls vs. sub-mm `c2v`/`v2c` chasing**: Once
>         your semantic convex hulls cleanly match the 6-view visual/collision
>         overlay (tightly following the silhouette with zero visual protrusion
>         and unobstructed functional cavities/openings), **stop iterating**—do
>         not burn extra script iterations chasing sub-millimeter chord or
>         percentile differences.
>     *   **Spheres & Cylinders** (balls, cans, cylinders on their side)
>         naturally roll at small tilt angles on the tilt table (`Scenario 2`),
>         roll long distances (`Scenario 3`), roll off a cliff edge early
>         (`Scenario 7`), and slide off each other in a twin self-stack
>         (`Scenario 8`).
>
> Always inspect the JSON telemetry and the `.png` contact sheet together to
> decide whether a metric reflects a **true modeling defect** or **expected
> physics for that object**.

--------------------------------------------------------------------------------

## 2. Running the Static & Dynamic Audit Suite (`audit_scenarios.py`)

Resolve `SKILL_DIR` to the directory containing this `SKILL.md` file. Bundled
[`scripts/audit_scenarios.py`](scripts/audit_scenarios.py) declares its Python
dependencies (`mujoco`, `trimesh`, `scipy`, `numpy`, `Pillow`, `absl-py`) via a
PEP 723 `# /// script` header, so `uv run` automatically provisions and caches
an isolated environment on first use:

```bash
SKILL_DIR="/path/to/skills/mujoco-audit"

# Fast (<0.3s) static XML, PBR material scalar-vs-layer, and .obj mesh/UV hygiene check:
uv run "$SKILL_DIR/scripts/audit_scenarios.py" \
  --xml_path=/path/to/model.xml \
  --static_only

# Run all 10 scenarios (default for deep audits or blind triage):
uv run "$SKILL_DIR/scripts/audit_scenarios.py" \
  --xml_path=/path/to/model.xml \
  --out_dir=<ArtifactDir>/audit_out \
  --label=<asset_name>

# Or run only a fast/targeted subset of scenarios (e.g. Scenarios 1 and 4):
uv run "$SKILL_DIR/scripts/audit_scenarios.py" \
  --xml_path=/path/to/model.xml \
  --out_dir=<ArtifactDir>/audit_out \
  --label=<asset_name> \
  --scenarios=1,4
```

### Customizing Thresholds (`--thresholds_json`)

`DEFAULT_THRESHOLDS` in `audit_scenarios.py` are **configurable CLI heuristic
defaults, not universal physical laws**. Override any threshold or scaling ratio
via `--thresholds_json` whenever physically warranted for small, large,
multi-material, or compliant/elastomeric objects:

```bash
--thresholds_json='{
  "hull_density_cv_tol": 0.30,
  "hover_tol_mm": 1.5,
  "bounce_ratio_tol": 0.45
}'
```

*   **Configurable `DEFAULT_THRESHOLDS` CLI defaults**: `hover_tol_mm` (`2.0`),
    `min_flat_slip_deg` (`8.0`), `hull_density_cv_tol` (`0.15`),
    `max_residual_ang_speed_rad_s` (`0.25`), `plugged_cavity_rays_tol` (`12`),
    `plugged_cavity_deficit_mm_tol` (`8.0`), `plugged_through_holes_tol` (`3`),
    `grasp_lift_slip_mm_tol` (`25.0`), `grasp_shake_slip_mm_tol` (`20.0`),
    `ledge_overhang_diff_pct_tol` (`25.0`), `high_speed_drop_scale` (`6.0`),
    `thin_slab_min_dim_ratio` (`0.20`), `bounce_ratio_tol` (`0.35`),
    `max_plausible_density_g_cm3` (`22.6`).
*   **Never game `--thresholds_json` to mask collider defects**: Only adjust
    thresholds when justified by the real object's scale, material compliance,
    or multi-material composition. Never raise `plugged_through_holes_tol` or
    `plugged_cavity_rays_tol` to silence a `CHECK` on a functional handle
    opening, clip loop, or container cavity—fix the collision hulls (e.g., by
    decomposing a U-shaped clip or handle into clean left-arm, right-arm, and
    crossbar convex hulls) so the opening is genuinely unobstructed.
*   You can also add `"$SKILL_DIR/scripts"` to `sys.path` and call
    `audit_scenarios.validate_static_and_mesh_hygiene(xml_path)` or
    `audit_scenarios.run_all_scenarios_for_asset(xml_path, out_dir, label,
    thresholds={...}, scenarios="1,4")` directly inside any scratch Python
    script run via `uv run`.

--------------------------------------------------------------------------------

## 3. The 7-Point Static & Structural Audit Checklist

Alongside dynamic simulation, verify these 7 structural rules from
[`rules/mujoco_asset_standards.md`][asset-standards] (many of which are automatically
checked by `audit_scenarios.validate_static_and_mesh_hygiene(xml_path)`):

1.  **Model & root body naming + zero transform
    ([`rules/mujoco_asset_standards.md`][asset-standards] §2.2 & §3.2)**: Verify
    `spec.modelname` is a descriptive `snake_case` name (never `untitled` or a
    raw number), and verify there is a single top-level asset body in
    `spec.worldbody.bodies` with a descriptive `snake_case` name (never `root`,
    `blender_export`, `model`, `object`, `body`), zero position
    (`pos == [0, 0, 0]`), identity orientation (`quat == [1, 0, 0, 0]`), and no
    `<freejoint/>` in the reusable `model.xml`.
2.  **Canonical orientation, real-world dimensions (`<mesh scale="..."/>`),
    sensible origin & bidirectional collision alignment
    (`UP_POSZ_FORWARD_POSX_RIGHT_NEGY`,
    [`rules/mujoco_asset_standards.md`][asset-standards] §3.1 & §6.1)**:
    *   **Real-world visual & dimension due diligence (reference product image,
        specs & `search_web`)**:
        *   **Visual Comparison against Reference Photo**: Whenever a real-world
            reference photo or product image is provided, you **MUST visually
            compare** the rendered 6-view sheet of the updated asset against the
            **reference photo** to verify that the asset's **silhouette/shape,
            aspect ratio, primary & secondary colors/tint, surface
            markings/labels, transparency/opacity, and component structure**
            match the real physical object. Explicitly flag any color mismatch
            (e.g., red vs. orange, green vs. blue), wrong object substitution
            (e.g., lime vs. plastic egg), missing label/cap, or material/opacity
            discrepancy!
        *   **Dimension & Spec Cross-Check (Guard Against "Similar Object" Web
            Overwrites!)**: Always cross-check `vis_span_cm` against reference
            product specs, `<custom>` metadata, and the reference photo.
            *   **When to use `search_web` & rescale
                (`<mesh scale="sx sy sz"/>`)**: Use `search_web` when you can
                identify the **exact brand/SKU/model** shown in the reference
                photo, **or** to check whether the asset has an obvious unit or
                capture scale bug (e.g., a `2×` scale error like a `45 cm`
                dinner plate or `13.5 cm` stress ball, or a `10×`/`100×`/`1000×`
                cm/mm-to-m unit error).
            *   **NEVER overwrite a physically plausible real scan using a
                "similar" web listing**: When auditing a real physical object
                whose exact SKU/manufacturer cannot be confirmed, **do NOT
                rescale an already physically plausible asset** (e.g., changing
                a `14 cm` bowl to `18 cm` or applying non-uniform
                `sx != sy != sz` aspect distortion) just to match a generic or
                merely *similar* product found online—the physical scan and
                reference image are the primary ground truth!
    *   **Function-First Collision Philosophy (Hand-Authored Convex Hulls &
        Primitives First, `coacd` Fallback When Needed)**:
        *   **The collision geometry must serve the physical function of the
            asset**: Open containers must accept dropped objects, handle/clip
            loops must stay unobstructed for grasping, resting bases must sit
            flush without wobble, rollers must roll smoothly, and articulated
            links must clear each other across their full joint range.
        *   **Prefer hand-authored convex hulls and analytic primitives first**:
            Decompose each rigid link by hand into clean analytic primitives
            (`sphere`, `capsule`, `cylinder`, `box`, `ellipsoid`) or per-part
            $\le 64$-vertex convex hulls (`bmu.export_convex_hull_col` or
            semantic sub-mesh slicing in `trimesh`).
        *   **Fall back to `coacd` and tune its parameters when hand
            decomposition is too complex**: If an organic or intricately
            contoured mesh is too difficult to decompose by hand, run `coacd`
            (e.g., `uv run --with coacd --with trimesh python3 ...`) and
            actively tune `threshold`, `max_convex_hull`, `preprocess_mode`
            (`"auto"` vs. `"off"`), and `<mesh maxhullvert="64"/>` until the
            hulls match the asset's function without plugging cavities or
            shattering closed walls.
    *   Verify `+Z` is up, `+X` is front, `-Y` is right, the origin `(0, 0, 0)`
        sits sensibly at the base, centroid, or pivot, and inspect
        `asset_info["collision_alignment"]` in `<label>_scenarios.json` (or call
        `audit_scenarios.compute_collision_alignment_summary(model, data)`
        directly on the standalone asset `model`). Confirm seam-filtered
        collider-to-visual surface fit (`c2v_mean_mm`, `c2v_p95_mm`,
        `bridged_col_area_pct`) and welded per-component visual-to-collider
        coverage (`v2c_p95_mm`, `uncollided_vis_area_pct`, and
        `missing_visual_components == []`). Do **not** rely solely on a
        whole-object AABB comparison, which misses diagonal corner overhang and
        internal uncovered components. Note: when inspecting per-geom masses in
        Python, read `spec.geoms[i].mass` on `MjSpec` (`mujoco.MjModel` only
        exposes per-body `model.body_mass`, not `model.geom_mass`), and when
        splitting `.obj` meshes with UV seams via `trimesh`, call
        `m.merge_vertices()` first and guard
        `len(c.vertices) >= 4 and np.min(c.extents) > 1e-4` to skip coplanar 2D
        sheets.
    *   **Fast In-Memory Candidate Hull Sweeps (Avoid Spawning Repeated CLI
        Invocations)**: Each standalone process startup adds Python/MuJoCo
        import overhead. When synthesizing or tuning semantic convex hulls
        (e.g., choosing Z-ring splits on a bowl/bottle or segment counts on
        stalks), **never** write `test_decomp1.py`, `test_decomp2.py`, … and
        invoke `uv run` repeatedly. Instead, evaluate multiple candidate
        parameter sets **in-memory inside a single Python script** (building an
        `MjSpec` and calling
        `audit_scenarios.compute_collision_alignment_summary(model, data)` or
        checking ray clearance inside a Python `for` loop) and write out the
        winning `.obj` files and `model.xml` in that single run. Likewise, set
        `WaitMsBeforeAsync: 10000` on `run_command` and never poll
        `manage_task("list" / "status")` in a busy loop.
    *   **Mandatory Per-Hull Color-Coded Visual Inspection & Semantic Part
        Audit**:
        *   Never inspect a multi-hull collision decomposition with all hulls
            rendered in the same uniform green `rgba`—identical colors hide
            merged hulls tenting across concave necks or recesses and asymmetric
            pie-wedge splits.
        *   In your 6-view inspection render (and Before-vs-After sheet),
            **color-code each collision geom with a distinct hue** and include
            Front (`+X`), Side (`+Y`), `3/4` Iso, Top (`+Z`), and Bottom (`-Z`)
            views alongside a semi-transparent Visual + Collision overlay.
            **Camera Framing Rule (No Cropping/Cut-Offs)**: Always set
            `cam.lookat` to the exact 3D AABB midpoint `0.5 * (bmin + bmax)` and
            set `cam.distance >= 1.75 * max_dim` (for `fovy = 45°`, perspective
            foreshortening on the front surface clips tall objects if
            `distance < 1.55 * max_dim`), verifying that the entire object (from
            bottom base to top cap) has $\ge 15\%$ margin inside every panel and
            is never cut off at the frame border.
        *   Visually and geometrically verify that each hull corresponds to a
            **sensible convex geometric part**—decomposing rigid bodies into as
            many clean analytic primitives or natively authored $\le 64$-vertex
            convex hulls (`maxhullvert="64"` compiler ceiling) as needed so
            concave profile inflections, functional cavities, rests, and grasp
            loops are not bridged over, while closed housings and flat/convex
            spans are not gratuitously over-fragmented into thin slivers.
        *   **Functional Contact Parsimony vs. Over-Decomposition**: Every
            collision geom has a runtime solver cost—choose a geom count
            proportionate to the object's **functional contact topology** (check
            `asset_info.n_col_geoms_by_body` and
            `asset_info.over_decomposed_bodies`). Only carve out concave
            cavities, slots, or through-holes that a robot finger, tool, or
            manipulated object physically enters or grasps:
            *   If a molded shell or closed housing (whose visual mesh has
                internal wall thickness or open boundary seams) has been
                shattered by blind volumetric CoACD into dozens of thin wall
                shards, **replace the shattered patchwork** with clean outer
                convex hulls ($\le 64$ vertices each) plus separate convex
                hulls or primitives for protruding buttons, rims, or feet that
                participate in contact.
            *   If an open bracket, clip, frame, or handle loop has a functional
                through-hole that CoACD partially webbed
                (`plugged_through_holes` $> 0$) or over-segmented into uneven
                slivers, slice its visual vertices along the structural limb
                junctions into clean $\le 64$-vertex convex limb hulls so
                `plugged_through_holes_by_axis == {'X': 0, 'Y': 0, 'Z': 0}`.
            *   Conversely, for foliage canopies (leaves/petals on a potted
                plant), bristles, or decorative surface crevices, wrap
                branches/clusters in smooth envelope hulls rather than splitting
                into hundreds of per-leaf hulls just to drive Scenario 4's
                `plugged_ray_count` or `plugged_through_holes` to `0`.
    *   **Raw `.obj` vs. Compiled `maxhullvert="64"` Truncation Check**:
        *   For every collision `<mesh>`, compare the raw `.obj` convex hull
            vertex count and volume against the compiled `model.mesh_vert`
            (`model.mesh_vertnum[mid]`, also reported in
            `asset_info.maxhullvert_truncated_geoms`). If a raw `.obj` has $>
            64$ vertices that get greedily decimated by `maxhullvert="64"`
            (causing flat lopsided facets, radial AABB shrinkage $> 1\text{
            mm}$, or volume loss $> 2\%$), flag and replace the collision hulls
            with clean natively authored $\le 64$-vertex convex parts.
3.  **Semantic naming across all elements
    ([`rules/mujoco_asset_standards.md`][asset-standards] §2.2)**: Verify all bodies,
    geoms, joints, sites, meshes, and materials have descriptive `snake_case`
    names (no leading double-underscore placeholders like `__box_surface` or
    generic `visual_00` / `collision_00`).
4.  **Group separation, zero visual mass & visible `rgba`
    ([`rules/mujoco_asset_standards.md`][asset-standards] §4.1–§4.3)**:
    *   Visual geoms (`contype == 0 and conaffinity == 0`) are in `group="2"`
        with `density="0"` and `mass="0"`.
    *   Collision geoms (`contype > 0 or conaffinity > 0`) are in `group="3"`
        with visible semi-transparent `rgba` ($\alpha \in [0.35, 0.60]$; never
        $\alpha = 0$).
    *   Semantic affordance `<site>`s (when present) are in `group="4"` with
        visible `rgba` ($\alpha \in [0.25, 0.50]$).
5.  **Mass, CoM, principal inertia & real-world product-weight due diligence
    ([`rules/mujoco_asset_standards.md`][asset-standards] §4.3)**:
    *   Verify total mass (`np.sum(model.body_mass[1:])`), effective hull
        density ($\rho_{\text{eff}} = m / V_{\text{hull}}$), per-hull density
        uniformity (`hull_density_cv`), and per-link `body_ipos` /
        `body_inertia` satisfy the triangle inequality ($I_1 + I_2 \ge I_3$).
    *   **Root-Cause Check When `hull_density_cv > 0.15`**: Never treat a high
        `hull_density_cv` as just an XML number-rounding issue without first
        inspecting the collision meshes! Often `hull_density_cv > 0.15` is the
        canary indicator that `maxhullvert="64"` truncated a 150–270 vertex
        CoACD hull (shrinking its compiled volume relative to the pre-truncation
        CoACD mass) or that CoACD produced bad pie-wedge / neck-bridging hulls.
        Inspect the per-hull color-coded render, Z-ranges, and raw `.obj` vertex
        counts first, and rebuild the collision hulls into clean semantic convex
        parts ($\le 64$ native vertices per hull) before assigning
        volume-proportional masses! Conversely, for **multi-material / composite
        objects** (e.g., a heavy pot base with airy plastic foliage hulls, a
        metal tool head with a wooden/plastic handle, or a weighted lamp base),
        different material regions *should* have different densities
        (`hull_density_cv > 0.15` across the whole object is physically
        expected, while density within each material region is uniform)—assign
        realistic mass fractions per semantic part so the CoM sits in a
        physically realistic location, and never force uniform density across
        disparate materials or add nested internal "ballast" hulls just to drive
        `hull_density_cv` to `0`.
    *   **Mandatory online & metadata due diligence (`search_web`)**: Never
        blindly trust existing XML mass or guess from thin air. Check `<custom>`
        metadata and user-provided links first; **if none are provided, actively
        use `search_web` to search retail/manufacturer listings for the exact
        item (or comparable real-world objects of the same size and material)**
        to verify single-unit net weight and material composition, while
        checking for the four classic traps:
        1.  **Multi-pack total weights**: Check if the reference listing is a
            2-pack, 6-pack, 12-pack, or 30-pack and divide by pack count.
        2.  **Inhomogeneous multi-packs**: For mixed-size sets (e.g., 9-inch +
            12-inch tongs), match mass to the specific bounding-box size modeled
            by the asset rather than dividing by 2.
        3.  **Shipping weight vs. net weight & component double-counting**: When
            a product is split into companion assets (e.g., outer lunch bag +
            removable hard insert, or container + lid), verify the **sum** of
            components equals the unboxed net product weight.
        4.  **Effective hull density sanity check ($\rho_{\text{eff}}$)**: Flag
            and correct unphysical densities (e.g., a foam prop given real fruit
            or full-pack weight yielding $\rho_{\text{eff}} > 1.5\text{
            g/cm}^3$).
6.  **Contact, friction & joint parameters
    ([`rules/mujoco_asset_standards.md`][asset-standards] §7.1–§7.3)**:
    *   Verify `condim` (`3`, `4`, or `6`) and `friction` (`[sliding, torsional,
        rolling]`) match the object's physical material and contact/rolling
        regime (e.g., `condim="4"` torsional friction for manipulation props so
        pinched grasps resist in-finger spin, or `condim="6"` when rolling
        resistance is needed on spheres/cylinders), along with `solref`
        (`timeconst >= 2 * timestep`, `dampratio="1"`), `solimp`, and
        `margin="0"`.
    *   For articulated assets, verify **minimal degrees of freedom** (no
        redundant uncoupled hinge joints leaving an intermediate pivot/clevis
        body underactuated and floppy—for 1-DoF tools like tongs, scissors, or
        pliers, merge one arm into the root body for a single 1-DoF hinge or
        couple symmetric hinges via `<equality><joint>`), and verify joint type
        (`hinge` vs. `slide`), pivot (`pos`), axis (`axis`), radian `range`
        limits (e.g. jaws meet flush at closed limit), `damping`, `armature`,
        `frictionloss`, `stiffness`, and `solreflimit="0.005 1"` without
        self-collision lockup.
7.  **PBR materials, multi-layer 2D texture maps & texture colorspaces
    ([`rules/mujoco_asset_standards.md`][asset-standards] §4.4)**: Verify 2D
    basecolor/albedo textures specify `colorspace="sRGB"`, non-color 2D data
    maps (`role="normal"`, `role="roughness"`, `role="metallic"`,
    `role="occlusion"`, `role="orm"`) specify `colorspace="linear"`, and
    `<material>` tags either wire 2D `<layer>` texture maps for
    `roughness`/`metallic`/`normal` (with scalar `roughness="1.0"` /
    `metallic="1.0"` on `<material>` so Filament does not double-multiply the
    texture maps) or specify physically plausible scalar `metallic` and
    `roughness` values when untextured, without redundant visual geom `rgba`
    overrides.

--------------------------------------------------------------------------------

## 4. Reference Guide: Global Telemetry & The 10 Scenarios

### Global Asset Telemetry (`asset_info`)

*   **`total_mass_g`** (`g`): Sum of body masses
    (`mjModel.body_mass[1:] * 1000`). Catches `10×`/`1000×` unit errors or
    double-counted visual mesh mass.
*   **`vis_span_cm` / `col_span_cm`** (`[sx, sy, sz]` in `cm`): Visual
    (`group="2"`) vs. collision (`group="3"`) AABB spans. Catches scale bugs and
    AABB collider bloat or deficit.
*   **`com_local_m` / `com_z_above_floor_m`** (`m`): Composite world CoM and
    resting height above the floor (`z = 0`).
*   **`com_height_pct_of_z_span`** (`%`): Resting `CoM_z` as a percentage of
    total visual Z height (`50%` = mid-height; `< 45%` = bottom-weighted;
    `> 55%` = top-heavy).
*   **`z_band_mass_density`** (`dict`: `lower_third`, `mid_third`,
    `upper_third`): Per-tier `n_hulls`, `vol_cm3`, `mass_g`, `mass_pct`, and
    `density_g_cm3`. Use this to verify multi-material mass splits (e.g., dense
    pot base vs. airy upper foliage hulls).
*   **`total_hull_vol_cm3`** (`cm³`): Sum of compiled 64-vertex convex-hull
    volumes across all collision geoms (`group="3"`).
*   **`eff_hull_density_g_cm3`** (`g/cm³`): `total_mass_g / total_hull_vol_cm3`.
    Compare against water (`1.0 g/cm³`): hollow containers `0.05–0.4`,
    plastics/woods `0.5–1.4`, metals `2.0–8.0`.
    Above `max_plausible_density_g_cm3` (`22.6`, denser than osmium) the run
    prints `WARNING:` and fills `asset_info.asset_warnings`, which usually
    means a kg-vs-g unit error or a runaway mass override.
*   **`hull_density_cv`** (dimensionless): Coefficient of variation ($\sigma /
    \mu$) of per-hull densities (`INFO`). Should be `≈ 0` within a single
    homogeneous material, and naturally `> 0.15` across multi-material or
    composite objects.
*   **`collision_alignment`** (`dict`): Bidirectional surface alignment summary
    from `compute_collision_alignment_summary(model, data)` (`status`, `issues`,
    `c2v_mean_mm`, `c2v_p95_mm`, `bridged_col_area_pct`, `v2c_p95_mm`,
    `uncollided_vis_area_pct`, `missing_visual_components`).
*   **`static_and_mesh_hygiene`** (`dict`): Fast static XML, PBR scalar-vs-layer
    multiplication, and `.obj` topology/UV check from
    `validate_static_and_mesh_hygiene(xml_path)` (`passed`, `errors`,
    `warnings`, `mesh_topology`).

### The 10 Auto-Scaling Physics Scenarios (`scenarios.*`)

1.  **`1_six_pose_drop_and_hover` — 6-Orientation Drop (`±X, ±Y, ±Z`) & Resting
    Hover Gap**
    *   **Metrics**: `upright_vis_hover_mm`, `upright_col_min_mm`,
        `upright_normal_force_N`, `expected_weight_N`, `any_nan`,
        `max_final_speed_m_s`, per-pose `vis_min_z_mm` (`+Z_up`, `-Z_up`, etc.).
    *   **What It Catches**: Bloated bottom colliders causing tabletop hover
        (`upright_vis_hover_mm > +2.0 mm`), missing top/bottom collider coverage
        causing visual floor sink (`< -2.0 mm`, e.g., in `-Z_up` when a lid
        collider is too thin), or NaNs/instability.
    *   **Judgment**: Round objects may still roll slowly at the end of a drop
        (`max_final_speed_m_s > 0.05`).
2.  **`2_tilt_table_sweep` — Continuous Dual-Axis Tilt Sweep (`0° -> 55°` along
    `X` & `Y`)**
    *   **Metrics**: `axes.X_axis` & `axes.Y_axis`: `slip_angle_deg`,
        `tip_angle_deg`, `implied_mu` ($\tan\theta_{\text{slip}}$).
    *   **What It Catches**: Missing/low contact friction (`implied_mu < 0.2`)
        or top-heavy CoM (`tip_angle_deg < slip_angle_deg`).
    *   **Judgment**: Spheres and cylinders roll at `< 8°` (`tip_angle_deg` /
        `slip_angle_deg` small)—this is normal rolling, not low friction.
3.  **`3_roll_and_isotropy` — Froude-Scaled Planar Push, Spin Decay & Hull
    Density Uniformity**
    *   **Metrics**: `roll_distance_cm`, `settle_time_s`, `settled_within_2p5s`,
        `final_ang_speed_rad_s`, `hull_density_cv`, `eff_hull_density_g_cm3`.
    *   **What It Catches**: Missing torsional or rolling friction when physical
        spin/roll damping is required (e.g., spheres or cylinders lacking
        `condim="6"` rolling resistance and leaving high
        `final_ang_speed_rad_s`), and unintended per-hull density jumps
        (`hull_density_cv > 0.15`) on homogeneous parts.
    *   **Judgment**: Multi-material objects (e.g., steel arms + silicone tips)
        naturally have slightly higher `hull_density_cv` (`~0.15–0.25`), whereas
        a homogeneous plastic tray should have `hull_density_cv ≈ 0.0`.
4.  **`4_three_axis_ray_and_cavity_probe` — Top-Down Cavity + 3-Axis (`X, Y, Z`)
    Through-Hole Rays & Marble Drop**
    *   **Metrics**: `has_visual_cavity`, `opened_joints_for_probe`,
        `plugged_ray_count_of_400`, `max_ray_plug_deficit_mm`,
        `plugged_through_holes_by_axis` (`X, Y, Z`),
        `clear_through_holes_by_axis`, `probe_sphere_radius_mm`.
    *   **What It Catches**: Shrink-wrapped convex hulls bridging across open
        containers (bowls, mugs, open lunch bags) or blocking functional handle
        loops / pull rings.
    *   **Judgment**: Solid convex objects have `0` cavities. A small number of
        flagged rays (`1–4`) clipping a curved outer corner fillet, internal
        divider rib, or tiny rivet seam is benign if the main cavity/loop is
        clear (`clear_through_holes_by_axis` high and marbles enter the cavity).
5.  **`5_com_aligned_grasp_lift_shake` — Auto-Scaled CoM Parallel-Jaw Grasp,
    Hoist & 3 Hz Shake**
    *   **Metrics**: `grasp_axis`, `grasp_span_cm`,
        `exceeds_standard_16cm_gripper`, `hoist_height_cm`, `lift_slip_mm`,
        `shake_slip_mm`, `grasp_retained`.
    *   **What It Catches**: Slippery collision friction, overweight mass, or
        wedged side hulls that eject parallel fingers during lift/shake.
    *   **Judgment**: Wide objects (`grasp_span_cm > 16 cm`) naturally set
        `exceeds_standard_16cm_gripper = True`. Splayed spring tongs squeezed
        passively from the outside deflect their hinge—check active jaw closure
        in `Scenario 6` instead.
6.  **`6_articulation_sweep_and_polarity` — Joint Limit Sweep, Open/Close
    Polarity, Gravity-Hold & Self-Collision Check**
    *   **Metrics**: `num_articulated_joints`, per-joint `range`,
        `closes_at_limit`, `opens_at_limit`, `link_sep_at_rmin_cm`,
        `link_sep_at_rmax_cm`, `internal_contacts_at_limits`,
        `gravity_load_at_mid`, `frictionloss`, `stiffness`,
        `mid_pose_gravity_drift_pct`, `holds_against_gravity`.
    *   **What It Catches**: Inverted joint axes/limits, non-closing jaws,
        internal self-collision lockup at joint limits, and vertical/inclined
        positioning joints (e.g., height-adjustable columns, telescoping
        armrests, friction-positioned hinges or folding supports) that collapse
        under their own subtree weight during a `0.5 s` `mj_step` gravity-hold
        test because `frictionloss < gravity_load_at_mid`.
    *   **Judgment**: Rigid objects have `num_articulated_joints == 0` (`INFO`).
        Freely swinging pendulums or unlatched lids on an incline may
        intentionally swing under gravity, whereas height-adjustment slides and
        friction hinges must satisfy `holds_against_gravity == True`
        (`frictionloss >= 1.25 * gravity_load_at_mid` with
        `solreffriction="0.004 1"`).
7.  **`7_cliff_ledge_overhang_slide` — Quasi-Static Cliff-Ledge Overhang
    Tip-Off**
    *   **Metrics**: `tip_overhang_pct`, `expected_com_overhang_pct`.
    *   **What It Catches**: Skewed horizontal CoM causing premature or delayed
        tip-off compared to geometric center (`~50%` for symmetric bases).
    *   **Judgment**: Spheres and rollers roll off the curved edge early (`~10%`
        overhang); check `asset_info.com_local_m` directly for spheres.
8.  **`8_twin_self_stack_and_nudge` — Twin Self-Stacking & Table-Nudge
    Stability**
    *   **Metrics**: `stacked_stably_static`, `retained_after_table_nudge`,
        `vertical_separation_ratio_z_over_sz`.
    *   **What It Catches**: Bumpy top collision hulls (`coacd` artifacts) on
        flat-topped objects, or missing top lid colliders causing the upper copy
        to sink into the lower copy
        (`vertical_separation_ratio_z_over_sz < 0.95`).
    *   **Judgment**: Only flat-topped objects (cubes, closed flat-top boxes,
        coasters) should self-stack; spheres, cherries, open containers, and
        tongs naturally slide or nest off (`INFO`).
9.  **`9_pendulum_impact_and_sites` — Volume/Froude-Scaled Ballistic Impact &
    `<site>` Audit**
    *   **Metrics**: `striker_mass_g`, `striker_speed_m_s`,
        `peak_object_vx_m_s`, `inelastic_ref_vx_m_s`, `post_impact_slide_cm`,
        `num_sites`, `sites`, `issues`.
    *   **What It Catches**: `10×` mass/inertia outliers (`peak_object_vx_m_s`
        far from `inelastic_ref_vx_m_s`), `<site>`s placed in collision
        `group="3"` instead of `group="4"`, or sites buried below the floor.
10. **`10_high_speed_thin_slab_drop` — High-Speed (`6× max_dim`) Drop onto Thin
    Slab (`20% min_dim`)**
    *   **Metrics**: `drop_height_cm`, `slab_thickness_mm`,
        `tunneled_through_thin_slab`, `max_penetration_mm`,
        `resting_penetration_mm`, `rebound_height_cm`, `bounce_ratio`.
    *   **What It Catches**: High-velocity CCD tunneling through thin tabletops
        (`tunneled_through_thin_slab == True`, e.g., when thin arms are split
        into paper-thin hulls), resting sink
        (`resting_penetration_mm > 2.5 mm`), or undamped bounce
        (`bounce_ratio > 0.35`).

--------------------------------------------------------------------------------

## 5. Remediation & Before-vs-After Deliverable Workflow

When asked to **remediate / fix** an asset (not just detect):

1.  **Run Initial Diagnosis & Real-World Spec Due Diligence**:
    *   Inspect `model.xml` against the 7 static criteria (§3), actively
        researching and cross-checking the object's real-world dimensions,
        single-unit net weight (guarding against multi-pack, inhomogeneous pack,
        and shipping-weight traps), and material density ($\rho_{\text{eff}}$).
    *   Run `audit_scenarios.py` (choosing `--scenarios=all` or a
        prompt-appropriate subset per §1) to establish the **Before** baseline.
2.  **Remediate & Re-Decompose When Needed**:
    *   Apply fixes following [`rules/mujoco_asset_standards.md`][asset-standards]
        (§1–§8) and the 7-point checklist in §3 above.
    *   **Ensure the collision geometry serves the asset's function (§3.2)**:
        *   **Prefer hand-authored convex hulls and analytic primitives first**:
            Use analytic primitives (`sphere`, `capsule`, `cylinder`, `box`) for
            genuinely geometric parts, and decompose molded housings, open
            brackets/clips/handles, and axisymmetric/stepped vessels by hand
            into clean, natively authored $\le 64$-vertex convex hulls
            (`bmu.export_convex_hull_col` or semantic sub-part slicing in
            `trimesh` with shared boundary rings at cut planes) so functional
            cavities, rests, and through-holes remain unobstructed without
            sliver fragmentation.
        *   **Fall back to `coacd` when too complex to decompose by hand**: If
            an asset's geometry is too complex or organic to decompose by hand,
            never approximate curved silhouettes with blocky boxes—fall back to
            `coacd` (`uv run --with coacd --with trimesh python3 ...`) and tune
            its parameters (`threshold`, `max_convex_hull`, `preprocess_mode`,
            and `<mesh maxhullvert="64"/>`), inspect its per-hull color-coded
            render to verify it did not plug cavities or over-fragment closed
            shells, and assign volume-weighted masses across the compiled
            64-vertex convex hulls so `hull_density_cv ≈ 0.0` per homogeneous
            link.
    *   If the object has a coupled passive mechanism (and the prompt does not
        request Fast or Rigid-Only mode), keep the direct-joint baseline in
        `<asset_name>/` and create `<asset_name>_mechanical/` per
        [`rules/mujoco_asset_standards.md`][asset-standards] §7.2.
3.  **Verify After Remediation**:
    *   Re-run [`scripts/audit_scenarios.py`](scripts/audit_scenarios.py) via
        `uv run` on the remediated `model.xml` (plus any custom `MjSpec`
        mechanism experiment via `uv run`) to confirm all physical defects are
        resolved.
4.  **Render Visual Deliverables (Matched to Prompt Mode)**:
    *   **Before vs. After Comparison Sheet (`--before_xml` built-in helper)**:
        Pass `--before_xml=/path/to/before/model.xml`,
        `--comparison_out=<ArtifactDir>/remediated/<asset>_before_vs_after.png`,
        and (when available) `--real_img_path=/path/to/reference_photo.png`
        directly to `audit_scenarios.py` (or import `audit_scenarios` from
        `"$SKILL_DIR/scripts"` and call
        `audit_scenarios.render_before_vs_after_sheet(before_xml, after_xml,
        out_png, real_img_path=...)` via `uv run`) to automatically render an
        uncropped, framing-verified 3-row × 6-column comparison sheet showing
        **(Row 1) Real Asset Photo + Visual (`group="2"`)**, **(Row 2) Before
        Collision Hulls (`group="3"`, distinct per-hull colors + `3/4`
        Overlay)**, and **(Row 3) After Collision Hulls (`group="3"`, distinct
        per-hull colors + `3/4` Overlay)**. Always visually inspect the output
        PNG with `read_file` to confirm zero camera cropping and zero visual
        mesh protrusion!
    *   **Optional 360° Filament PBR Turntable Video (`showcase_shot`)**: When
        running an in-depth audit/remediation or new asset showcase (and not
        skipped by Fast/Rigid-Only prompts), run
        [`mujoco-showcase-shot/SKILL.md`](../mujoco-showcase-shot/SKILL.md).

[asset-standards]: ../../rules/mujoco_asset_standards.md
