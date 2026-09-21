#!/usr/bin/env python3
"""Builds src/fixtures/ligatures.pdf (see README.md there): subsets the
URW Nimbus Roman Type 1 font to the glyphs of two test sentences, gives it
a LaTeX-style built-in encoding with the fi/fl ligatures on codes 12/13,
and wraps it into a minimal one-page PDF without a ToUnicode map.
Usage: python3 src/fixtures/ligatures-fixture.py <out.pdf>
"""
import re
import sys

src=open('/usr/share/fonts/type1/urw-base35/NimbusRoman-Regular.t1','rb').read()
i=src.index(b'eexec')+5
while src[i:i+1] in (b'\r',b'\n',b' ',b'\t'): i+=1
clear=src[:i]; rest=src[i:]
j=rest.find(b'0'*64); enc=rest[:j]; trailer=rest[j:]
def decrypt(data,r,skip):
    c1,c2=52845,22719; out=bytearray()
    for c in data:
        out.append(c ^ (r>>8)); r=((c+r)*c1+c2)&0xFFFF
    return bytes(out[skip:])
def encrypt(data,r,lead):
    c1,c2=52845,22719; out=bytearray()
    for p in lead+data:
        c=p ^ (r>>8); out.append(c); r=((c+r)*c1+c2)&0xFFFF
    return bytes(out)
priv=decrypt(enc,55665,4)
keep=set('Ligature fixture for the PDF text extraction test river classification at sub-meter resolution is efficient the workflow fits official specifications')
names={' ':'space',':':'colon',';':'semicolon','-':'hyphen','.':'period',',':'comma'}
wanted={names.get(ch,ch) for ch in keep}|{'fi','fl','.notdef'}
cs=priv.index(b'/CharStrings')
head=priv[:cs]
m=re.match(rb'/CharStrings\s+(\d+)\s+dict\s+dup\s+begin\s*',priv[cs:])
p=cs+m.end(); entries=[]
while True:
    mm=re.match(rb'\s*/([^\s/{}\[\]()]+)\s+(\d+)\s+(RD|-\|)[ ]',priv[p:])
    if not mm: break
    name=mm.group(1).decode(); n=int(mm.group(2)); start=p+mm.end(); binary=priv[start:start+n]
    q=start+n
    mm2=re.match(rb'\s*(ND|\|-)\s*',priv[q:]); q+=mm2.end()
    entries.append((name,priv[p:q])); p=q
tail=priv[p:]
kept=[e for e in entries if e[0] in wanted]
missing=wanted-{e[0] for e in kept}
newpriv=head+b'/CharStrings %d dict dup begin\n'%len(kept)+b''.join(e[1] for e in kept)+tail
newenc=encrypt(newpriv,55665,b'XXXX')
newfont=clear+newenc+trailer
print('glyphs kept',len(kept),'of',len(entries),'missing',missing,'font bytes',len(newfont),'(was',len(src),')')

font=newfont
out_path=sys.argv[1]
i=font.index(b'eexec')+len(b'eexec')
while font[i:i+1] in (b'\r',b'\n',b' ',b'\t'): i+=1
clear=font[:i]; rest=font[i:]
j=rest.find(b'0'*64); enc=rest[:j]; trailer=rest[j:]
# LaTeX-style builtin encoding: ligatures on low codes where StandardEncoding has nothing.
names={' ':'space',':':'colon',';':'semicolon','-':'hyphen','.':'period',',':'comma'}
lines=[b'/Encoding 256 array', b'0 1 255 {1 index exch /.notdef put} for', b'dup 12 /fi put', b'dup 13 /fl put']
for ch in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ':
    lines.append(b'dup %d /%s put'%(ord(ch),ch.encode()))
for ch,name in names.items():
    lines.append(b'dup %d /%s put'%(ord(ch),name.encode()))
lines.append(b'readonly def')
encoding=b'\n'.join(lines)
assert b'/Encoding StandardEncoding def' in clear
clear=clear.replace(b'/Encoding StandardEncoding def', encoding)
fontfile=clear+enc+trailer
L1,L2,L3=len(clear),len(enc),len(trailer)
text=b'(Ligature fixture for the PDF text extraction test: river classi\\014cation at sub-meter) Tj T* (resolution is ef\\014cient; the work\\015ow \\014ts of\\014cial speci\\014cations.) Tj'
content=b'BT /F1 12 Tf 14 TL 72 720 Td '+text+b' ET'
objs=[b'<< /Type /Catalog /Pages 2 0 R >>',
 b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
 b'<< /Length %d >>\nstream\n'%len(content)+content+b'\nendstream',
 b'<< /Type /Font /Subtype /Type1 /BaseFont /NimbusRoman-Regular /FontDescriptor 6 0 R >>',
 b'<< /Type /FontDescriptor /FontName /NimbusRoman-Regular /Flags 34 /FontBBox [-168 -281 1000 924] /ItalicAngle 0 /Ascent 683 /Descent -217 /CapHeight 662 /StemV 84 /FontFile 7 0 R >>',
 b'<< /Length %d /Length1 %d /Length2 %d /Length3 %d >>\nstream\n'%(len(fontfile),L1,L2,L3)+fontfile+b'\nendstream']
out=b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; offsets=[]
for n,o in enumerate(objs,1):
    offsets.append(len(out)); out+=b'%d 0 obj\n'%n+o+b'\nendobj\n'
xref=len(out)
out+=b'xref\n0 %d\n0000000000 65535 f \n'%(len(objs)+1)+b''.join(b'%010d 00000 n \n'%o for o in offsets)
out+=b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'%(len(objs)+1,xref)
open(out_path,'wb').write(out); print('written',len(out),'bytes')
