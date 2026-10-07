#!/bin/sh
set -eu
UPDATE_PARENT="$1"
UPDATE_TARGET="$2"
UPDATE_STAGED="$3"
UPDATE_BACKUP="$4"
UPDATE_DIRECTORY="$5"
UPDATE_TOKEN="$6"
UPDATE_STAGE_ROOT="$7"
UPDATE_EXECUTABLE="$8"
UPDATE_MOVED=0
UPDATE_SWAPPED=0
UPDATE_NEW_PID=""
UPDATE_RESULT="$UPDATE_DIRECTORY/install-result.json"
UPDATE_READY="$UPDATE_DIRECTORY/$UPDATE_TOKEN.ready"
rollback() {
  if [ -f "$UPDATE_DIRECTORY/$UPDATE_TOKEN.pid" ]; then
    UPDATE_NEW_PID=$(/bin/cat "$UPDATE_DIRECTORY/$UPDATE_TOKEN.pid")
    case "$UPDATE_NEW_PID" in ''|*[!0-9]*) UPDATE_NEW_PID="";; esac
  fi
  if [ -n "$UPDATE_NEW_PID" ]; then
    UPDATE_COMMAND=$(/bin/ps -ww -p "$UPDATE_NEW_PID" -o command= 2>/dev/null || true)
    case "$UPDATE_COMMAND" in
      "$UPDATE_TARGET/Contents/MacOS/$UPDATE_EXECUTABLE"|"$UPDATE_TARGET/Contents/MacOS/$UPDATE_EXECUTABLE "*)
        /bin/kill "$UPDATE_NEW_PID" 2>/dev/null || true
        /bin/sleep 1
      ;;
    esac
  fi
  if [ "$UPDATE_SWAPPED" = 1 ]; then
    /bin/mv "$UPDATE_TARGET" "$UPDATE_STAGE_ROOT/failed.app" || true
  fi
  if [ "$UPDATE_MOVED" = 1 ]; then
    /bin/mv "$UPDATE_BACKUP" "$UPDATE_TARGET" || true
  fi
  printf '%s\n' '{"status":"error","message":"自动更新未完成，旧版本已保留或恢复。请重试或手动安装。"}' > "$UPDATE_RESULT"
  /usr/bin/open -n -a "$UPDATE_TARGET" || true
  exit 1
}
trap rollback HUP INT TERM
UPDATE_WAIT=0
while /bin/kill -0 "$UPDATE_PARENT" 2>/dev/null; do
  UPDATE_WAIT=$((UPDATE_WAIT+1))
  [ "$UPDATE_WAIT" -lt 240 ] || rollback
  /bin/sleep 0.25
done
[ -d "$UPDATE_TARGET" ] && [ -d "$UPDATE_STAGED" ] && [ ! -e "$UPDATE_BACKUP" ] || rollback
/bin/mv "$UPDATE_TARGET" "$UPDATE_BACKUP" || rollback
UPDATE_MOVED=1
/bin/mv "$UPDATE_STAGED" "$UPDATE_TARGET" || rollback
UPDATE_SWAPPED=1
/usr/bin/open -n -a "$UPDATE_TARGET" || rollback
UPDATE_WAIT=0
while [ ! -f "$UPDATE_READY" ]; do
  UPDATE_WAIT=$((UPDATE_WAIT+1))
  [ "$UPDATE_WAIT" -lt 120 ] || rollback
  /bin/sleep 0.5
done
printf '%s\n' '{"status":"success"}' > "$UPDATE_RESULT"
# The old app remains as a recovery copy. Product data is never moved or removed.
exit 0
