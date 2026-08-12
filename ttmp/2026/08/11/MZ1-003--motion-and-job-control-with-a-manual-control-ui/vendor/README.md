# Firmware source evidence (excerpts)

Excerpts from the two Carvera firmware trees, kept as line-citable evidence
for MZ1-003's jog-speed and open-question findings. Only the files actually
cited are retained; both projects are GPL (see COPYING in each subtree).

Re-clone the full trees if more is needed:

    git clone https://github.com/MakeraInc/CarveraFirmware vendor/stock-carvera-firmware
      @ 1683b6fb5c7ec1d341c476c6fdb2a22f7a26220e   (stock — what the Z1 runs)
    git clone https://github.com/Carvera-Community/Carvera_Community_Firmware vendor/carvera-community-firmware
      @ 9ac0123018a3f221f18db35cc11667203cd332bd

What each retained file proves:

- stock `SimpleShell.cpp` (`SimpleShell::jog`): `$J`'s F word is a SCALE OF
  MAX RATE ("optional speed is scale of max_rate"; `delta_move(delta,
  rate_mm_s*scale, …)`). Values >= 1 all mean maximum — confirmed by the
  identical-speed jogs observed on hardware 2026-08-11.
- community `SimpleShell.cpp`: the community fork redefined F as mm/min
  (`/60.0F`) and moved the scale to an S word — why the reference
  controller's mm/min values are wrong for stock.
- stock `Player.cpp` (`Player::play_command`): recognises only `-v`
  (verbose); no `-O` on stock. Refuses `play` while playing with "Currently
  printing, abort print first". SILENTLY returns if the machine is not
  homed — no error is printed.
- stock `Endstops.cpp` (`process_home_command`): homing parses axis letters,
  so single-axis homing (`$H X`) is supported by the source. Not yet
  exercised on the machine.

Added during the spindle investigation (2026-08-12):

- stock `spindle/PWMSpindleControl.cpp|h`, `SpindleControl.cpp|h`: the Z1's
  speed loop — velocity-form, duty += P*error (an integrator despite the
  name), D-on-Δerror gated to CARVERA_AIR, control_I loaded but never used;
  M957 telemetry and M958 runtime gains; stall supervision thresholds.
- community `spindle/PIDPWMSpindleControl.cpp|h`: the opt-in replacement —
  positional PID with static feedforward (ff_slope*target + ff_offset) and
  conditional-integration anti-windup.
