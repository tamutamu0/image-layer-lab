"""Generic geometry registration; source RGB is used for feature coordinates only.
Output pixels and alpha ALWAYS originate in generated assets. No color masks,
source-pixel projection, feathered cutouts or residual correction layers.
"""
import cv2,numpy as np,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);plan=json.loads((p/'plan.json').read_text());W,H=plan['width'],plan['height']
def fade_axes(alpha):
 # Broad partial alpha is appearance, not a smaller object to stretch to a box.
 # Antialiasing confined to an edge does not qualify. Do not modify any pixel mask.
 active=alpha>8;soft=(alpha>8)&(alpha<247)
 def along(axis):
  count=active.sum(axis=axis);valid=count>0
  if not valid.any():return False
  mostly_soft=(soft.sum(axis=axis)/np.maximum(count,1))>.65
  return float(mostly_soft[valid].mean())>.12
 return along(0),along(1)
sift=cv2.SIFT_create(nfeatures=6500,contrastThreshold=.018);bf=cv2.BFMatcher();results=[]
for job in plan['jobs']:
 r=json.loads((p/'assets'/f"{job['id']}.json").read_text());im=cv2.imread(str(p/r['file']),-1)
 ref=cv2.imread(str(p/'crops'/f"{job['id']}.png"),cv2.IMREAD_COLOR)
 h,w=im.shape[:2];alpha=im[:,:,3]/255.;best=None
 if job['kind']!='effect' and ref is not None:
  kr,dr=sift.detectAndCompute(cv2.cvtColor(ref,cv2.COLOR_BGR2GRAY),None)
  if dr is not None:
   for bg in [0,127,255]:
    flat=np.uint8(im[:,:,:3]*alpha[:,:,None]+bg*(1-alpha[:,:,None]));kg,dg=sift.detectAndCompute(cv2.cvtColor(flat,cv2.COLOR_BGR2GRAY),(alpha>.5).astype('uint8')*255)
    if dg is None:continue
    pairs=bf.knnMatch(dg,dr,k=2);good=[a for pair in pairs if len(pair)==2 for a,b in [pair] if a.distance<.72*b.distance]
    if len(good)<8:continue
    src=np.float32([kg[a.queryIdx].pt for a in good]);dst=np.float32([kr[a.trainIdx].pt for a in good]);M,mask=cv2.estimateAffinePartial2D(src,dst,method=cv2.RANSAC,ransacReprojThreshold=3,maxIters=5000)
    if M is None:continue
    inlier=mask.ravel()>0;count=int(inlier.sum());scale=float(np.hypot(M[0,0],M[1,0]));angle=float(np.degrees(np.arctan2(M[1,0],M[0,0])));spread=np.ptp(src[inlier],axis=0)/[w,h]
    if count<(20 if job['kind']=='background' else 8) or count/len(good)<.4 or not .65<scale<1.5 or abs(angle)>7 or np.linalg.norm(M[:,2])>max(w,h)*.4 or max(spread)<.22:continue
    error=float(np.median(np.linalg.norm(src@M[:,:2].T+M[:,2]-dst,axis=1)[inlier]));candidate={'method':'distributed-feature similarity','matrix':M.tolist(),'inliers':count,'matches':len(good),'medianError':error,'spread':spread.tolist(),'scale':scale,'angle':angle}
    if best is None or count>best['inliers']:best=candidate
 if best is None and job['kind'] not in ['background','effect']:
  ys,xs=np.where(im[:,:,3]>96)
  if len(xs):
   bx,by,bw,bh=job['bbox'];tx,ty,tw,th=bx*W/1000-r['x'],by*H/1000-r['y'],bw*W/1000,bh*H/1000
   sx,sy=tw/(xs.max()-xs.min()+1),th/(ys.max()-ys.min()+1)
   # Conservative global scaling preserves text and product proportions.
   if job['kind'] not in ['surface']:
    s=min(sx,sy);sx=sy=s
   preserve_x,preserve_y=fade_axes(im[:,:,3]) if job['kind']=='surface' else (False,False)
   if preserve_x:sx=1.
   if preserve_y:sy=1.
   if .4<sx<2.2 and .4<sy<2.2:
    ax=tx+(tw-(xs.max()-xs.min()+1)*sx)/2-xs.min()*sx;ay=ty+(th-(ys.max()-ys.min()+1)*sy)/2-ys.min()*sy
    if preserve_x:ax=0.
    if preserve_y:ay=0.
    best={'method':'preserve generated fade axis + hard-edge registration' if preserve_x or preserve_y else 'AI complete-object bounds + whole-asset scale','matrix':[[sx,0,ax],[0,sy,ay]],'sourcePixelTransfer':False,'preservedFadeAxes':{'x':bool(preserve_x),'y':bool(preserve_y)}}
 if best:
  M=np.array(best['matrix']);corners=np.array([[0,0],[w,0],[0,h],[w,h]])@M[:,:2].T+M[:,2];lo=np.floor(np.minimum(corners.min(axis=0),[0,0])).astype(int);hi=np.ceil(np.maximum(corners.max(axis=0),[w,h])).astype(int);M[:,2]-=lo
  rgba=im.astype(np.float32)/255;rgba[:,:,:3]*=rgba[:,:,3:4];warped=cv2.warpAffine(rgba,M,tuple(hi-lo),flags=cv2.INTER_LANCZOS4,borderMode=cv2.BORDER_CONSTANT);warped=np.clip(warped,0,1);warped[:,:,:3]/=np.maximum(warped[:,:,3:4],1e-6);warped[warped[:,:,3]<1/255,:3]=0
  file=f"assets/{job['id']}-{r['attempt']}-registered.png";cv2.imwrite(str(p/file),np.uint8(np.clip(warped*255+.5,0,255)));best['canvasOffset']=lo.tolist();r.update(file=file,x=r['x']+int(lo[0]),y=r['y']+int(lo[1]),width=int(hi[0]-lo[0]),height=int(hi[1]-lo[1]),registration=best)
 else:r['registration']={'method':'retain generated placement'}
 results.append(r)
(p/'registered.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps([{'id':r['id'],'method':r['registration']['method']}for r in results]))
