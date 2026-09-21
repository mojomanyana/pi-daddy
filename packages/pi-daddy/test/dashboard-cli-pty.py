#!/usr/bin/env python3
"""Model-free PTY regression for dashboard readline redraw/feedback/replay behavior."""
import json, os, pty, re, select, socket, subprocess, sys, tempfile, threading, time

root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp=tempfile.mkdtemp(prefix="pi-daddy-dashboard-pty-")
sock=os.path.join(tmp,"host.sock")
actions=[]
frame={"version":"producer-dashboard-frame-v1","source":None,"debrief":None,"attention":{"attentionUsed":0},"tip":"tip-1","actions":[{"key":"pause","label":"Pause new dispatch"}],"control":"not-assessed","acknowledgement":"readback-only","error":"fixture host error"}
def serve():
 s=socket.socket(socket.AF_UNIX);s.bind(sock);os.chmod(sock,0o600);s.listen()
 while len(actions)<2:
  c,_=s.accept(); data=c.recv(65536); request=json.loads(data.decode())
  if request["operation"]=="frame": result=frame
  elif request["operation"]=="human-action":
   actions.append(request["key"]); time.sleep(.45)
   result={"state":"acknowledged","result":{"application":"pending-ordinary-boundary"}}
  else: result={"state":"readback-only"}
  c.sendall((json.dumps({"ok":True,"result":result})+"\n").encode());c.close()
threading.Thread(target=serve,daemon=True).start()
master,slave=pty.openpty()
p=subprocess.Popen(["node",os.path.join(root,"src/products/dashboard-cli.ts"),"--host-socket",sock,"--no-color"],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave)
def read(seconds):
 end=time.time()+seconds; out=b""
 while time.time()<end:
  ready,_,_=select.select([master],[],[],.05)
  if ready: out+=os.read(master,65536)
 return out.decode(errors="replace")
out=read(.5);os.write(master,b"pau");out+=read(.7)
# Interpret the last clear/home redraw as the visible terminal screen, not historical terminal echo.
visible=out.rsplit("\x1b[2J\x1b[H",1)[-1]
visible=re.sub(r"\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -/]*[@-~]", "", visible)
assert "COMMAND — type an exact listed key, then Enter (refresh never acts): pau" in visible, visible
os.write(master,b"se\n");os.write(master,b"pause\n");out+=read(1.1)
assert actions==["pause"], actions
assert "HOST ERROR — fixture host error" in out, out
assert "pending-ordinary-boundary, so no applied effect is claimed" in out, out
p.terminate();p.wait(timeout=3);os.close(master)
print("PTY_OK",json.dumps({"actions":actions,"bytes":len(out)}))
