# The VM's screen through its Screen Sharing (VNC), for what only a person's mouse and keys reach: the Finder, the
# Gatekeeper dialog, a notification banner. A shell inside the VM cannot do these (no Accessibility or Screen
# Recording for sshd; `screencapture` over ssh gets only the wallpaper). Coordinates are screen pixels of the 2048x1536
# picture `shot` saves. Run by vm.sh, which keeps a venv with asyncvnc (MIT) and Pillow.
#
#   screen.py IP shot FILE | click X Y | dclick X Y | drag X1 Y1 X2 Y2 | scroll X Y N (down, -N up) | key K[,K…] (Cmd,Alt,c)
#                | type TEXT
#                | pixel X Y (prints r g b) | sleep S          several in one call share one connection
import asyncio
import sys

import asyncvnc


async def main(ip, args):
    async with asyncvnc.connect(ip, username='admin', password='admin') as c:
        scale = c.video.width / 2048
        at = lambda v: int(int(v) * scale)  # noqa: E731
        i = 0
        while i < len(args):
            a = args[i]
            i += 1
            if a in ('click', 'dclick'):
                x, y = at(args[i]), at(args[i + 1])
                i += 2
                c.mouse.move(x, y)
                await asyncio.sleep(0.15)
                c.mouse.click()
                if a == 'dclick':
                    await asyncio.sleep(0.08)
                    c.mouse.click()
            elif a == 'drag':
                x1, y1, x2, y2 = (at(v) for v in args[i:i + 4])
                i += 4
                c.mouse.move(x1, y1)
                await asyncio.sleep(0.2)
                with c.mouse.hold():
                    await asyncio.sleep(0.4)
                    for k in range(1, 21):
                        c.mouse.move(x1 + (x2 - x1) * k // 20, y1 + (y2 - y1) * k // 20)
                        await asyncio.sleep(0.05)
                    await asyncio.sleep(0.6)
            elif a == 'scroll':
                x, y, n = at(args[i]), at(args[i + 1]), int(args[i + 2])
                i += 3
                c.mouse.move(x, y)
                await asyncio.sleep(0.15)
                for _ in range(abs(n)):
                    (c.mouse.scroll_down if n > 0 else c.mouse.scroll_up)()
                    await asyncio.sleep(0.01)
            elif a == 'key':
                c.keyboard.press(*args[i].split(','))
                i += 1
            elif a == 'type':
                c.keyboard.write(args[i])
                i += 1
            elif a in ('shot', 'pixel'):
                from PIL import Image
                img = Image.fromarray(await c.screenshot()).convert('RGB')
                if a == 'shot':
                    img.save(args[i])
                    i += 1
                else:
                    print(*img.getpixel((at(args[i]), at(args[i + 1]))))
                    i += 2
            elif a == 'sleep':
                await asyncio.sleep(float(args[i]))
                i += 1
            else:
                sys.exit(f'screen.py: unknown step {a}')
            await asyncio.sleep(0.2)
        await asyncio.sleep(0.3)


if __name__ == '__main__':
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
