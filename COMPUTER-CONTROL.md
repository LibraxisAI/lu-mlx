# Computer control

With computer control a model can look at your screen and use the mouse and the keyboard in apps you approve. It is off until you switch it on.

It works in the foreground with your real pointer. While LU works, you see every move.

Computer control is in beta in 3.0.6, and the app shows the word Beta at its switch. It is new and not proven in every app yet, so watch what it does and stop it when it goes wrong. It can still change, and [Known limits](#known-limits) says what has been tested in a real window and what has not. On a Mac it is in the app but not fully tested yet, and the app says so under the switch and in the card that asks at the first use in a chat.

## Switch it on

**Settings**, **Agent**, **Agent Permissions**, **Computer control**.

From then on the agent chat can use it. A voice session can use it once **Where it may work** at the top of Voice is set to **Whole computer**. Choosing that level also switches computer control on. With **Workspace only**, or with the **Agent** switch of Voice off, a voice session has no screen: LU starts nothing of computer control and asks nothing about it. See [VOICE.md](VOICE.md).

## What you see while LU works

On Windows and macOS the LU window gets out of the way. It shrinks to a small panel in the top right corner of the screen LU works on, and comes back at the size and place it had when the work is over or stopped. The panel shows the current step and, below it, what the model thinks, does and writes, with the pictures of what it saw. **Pause** and **Stop** are in its head at any time, and the two shortcuts are named at its foot. The panel keeps its size whatever it shows. It takes clicks and does not take the keyboard, so the app LU works in keeps the focus.

The panel stands in a corner of the screen and does not lock that corner. When LU needs something under it (the close button of a maximized app, a menu), the panel slides to another corner of the same screen and stays there until LU needs that one. It goes straight down or up on its own side first. You can send it to any corner yourself with the short bar at its top edge: press it for the next corner, or drag it toward the corner you want. LU starts there from then on, until you quit the app. With less motion asked for in the system settings the panel changes corners in one step.

On Windows the edge of that screen also glows softly in purple for as long as LU works on it, including while LU waits for your answer. The glow takes no clicks. Neither the panel nor the glow is in the pictures the model gets: the place of the panel is black there, and the model is told where it is. A step that aims at that place does not run and is not put to you for confirmation. The panel moves away first, the model gets a new picture that shows the place, and decides again. Only on a screen too small for the panel to step aside does that place stay out of reach.

On Linux, and wherever the window cannot shrink, the window stays as it is and a bar at the top says **LU is controlling this computer**. It carries the **Stop** button and leaves a few seconds after the work is done. In Voice the row of switches next to the title and the question above the controls stay clear of the bar.

## What LU asks

The first time computer control is used in a chat, LU asks whether it may be used in that chat at all. The question is a card in the conversation, at the tool call that wants the screen, with **Allow** and **Deny**. Until you click, LU looks at nothing and does nothing: no screenshot, no list of windows, no click. The yes holds for that one chat. A new chat asks again, and so does every chat after the app was restarted. Only a click on **Allow** allows it. No setting, no permission level, no app that is always allowed and no autonomous session does, and neither does a key or a spoken word. With **Deny** the model is told that you did not allow it, and LU does not ask again until you send your next message. The questions below come on top of it.

In a voice session the card stands on the voice surface, and LU says aloud that it waits for your click. A spoken yes does not allow it. LU answers once that this one needs your click, and the model does not hear the yes. A spoken **no** or **stop** declines, like **Deny**.

LU asks before it touches an app for the first time. You can allow the app once, for this session or always, or decline.

That question is about using an app, not about seeing it. A picture of the screen shows the whole display, with the windows of apps you have not allowed, and the list of open windows names all of them. Only the windows LU never touches (see below) are painted black in the picture. Close what the model should not see before you click **Allow** on the card. A minimized window is not in the picture, but its title is still in the list.

The question stands directly above the input field in the chat, and above the controls of the session in Voice. It is not a message in the conversation. While LU is shrunk to the panel, the question stands at the bottom of the panel, and the edge of the panel turns purple for as long as LU waits for you. It is answered with the mouse: the panel does not take the keyboard, so the app LU works in keeps the focus and an open menu there stays open. In the window, Escape means no.

By default LU also asks before every action. A session is supervised: you confirm each click and each piece of typing.

Switch on **Autonomous** in a question or in the bar and LU asks only before anything that sends, buys, deletes or changes permissions. That holds for the session and ends with it.

The question of a sensitive action says in red why it is one, in a supervised session as in an autonomous one. That covers anything that sends, buys, deletes or changes permissions, a click whose target LU cannot name, and typing when LU cannot check which field has the focus. A button, link or menu item without a name counts as a target LU cannot name. On Windows and Linux, Alt with a letter is asked the same way, because it presses a button or opens a menu from anywhere in a window. On macOS those keys type a character, and nothing changes there.

In a voice session LU also asks these questions aloud, and you can answer with **yes** or **no**. A spoken yes confirms an ordinary action: a click, a scroll, text in a field. A sensitive action still needs a click, because speech recognition can mishear and the microphone hears the whole room. A spoken no is always taken. While LU is paused, a spoken yes or no answers nothing. The card at the first use in a chat is not one of these questions: it needs the click on **Allow**, as described above.

## What LU never touches

These are fixed and cannot be allowed:

- Terminals and shells.
- Password managers.
- Sign-in and permission dialogs of the system.
- System settings for security and accounts.
- The Run dialog and system launchers.
- Windows that run with administrator rights.
- LU's own window.

LU does not type into a password field. If it cannot check which field has the focus, it asks first. A screenshot is not taken while a password field has the focus.

## Pausing and taking over

In an autonomous session LU pauses when you move the mouse. On Windows it is also built to pause when you press a key. **Ctrl+Alt+Space** (Control+Option+Space on a Mac) pauses from anywhere, in any session, without touching the mouse, and so does **Pause** in the panel. In a voice session you can also say **stop** or **wait** while a screen task runs. **Hold on** and **pause** work too. All of these lead to the same paused state.

A paused LU does nothing. The panel asks, where and as large as it is: **Take over** or **Let it continue**. Now it takes the keyboard too. Where the window does not shrink, the question covers the LU window, which comes to the front. It shows what LU did so far, and you can add an instruction for the rest of the task. In a voice session the thoughts of the model stand between the steps as the folded Thinking block of the chat. Escape takes over. Only your answer in that view ends a pause. Nothing the model writes can end it, and neither can a spoken yes.

The pause itself has no timer. The limit of the task keeps running, though: a screen task ends after 8 minutes, and the time you take to answer counts. A voice session ends the task after 9 minutes even if it is still paused.

With **Let it continue** LU looks at the screen again before it does anything, because you may have changed it. A question that was open when the pause began is still open afterwards, and a voice session asks it aloud again. With **Take over** the task ends like a stop.

The voice session itself goes on during a pause, and its status reads **Paused**.

## Stopping

- **Ctrl+Alt+Esc** from anywhere, while a session runs. It stops at once, also during a pause.
- The **Stop** button in the panel, **Take over** in the paused view, and **Stop** in the bar.
- Ending the voice session that asked for the task: **Stop**, leaving Voice, or unloading Voice with the light switch next to the title. This also ends a task that is paused or waits for an answer.
- Switching **Agent** off or setting **Where it may work** to **Workspace only** in Voice while a screen task of that session runs.

Saying **stop** in a voice session pauses. To end the task from there, choose **Take over**. If there is nothing to pause yet, the word stops instead.

After a stop nothing stays pressed and nothing more is sent, and the window comes back.

## The model that looks at the screen

**Settings**, **Agent**, **Agent Permissions**, **Computer control**, **Model that looks at the screen**.

**Same as the chat model** is the default. How computer control runs then follows that model, and LU never asks about it. If the model can see images right now, it gets the screenshots, and on Windows the list of buttons and fields of the window next to them. If it cannot, it works with the list of buttons and fields that the app exposes, without a picture. The line under the setting says which of the two it is.

A local model sees images only while it is loaded with its image part, a second file that lies next to the model. Models with image input from the model catalog are downloaded with that file. A model without it works from the list. Computer control does not offer the download: **Add image input** is on the model's row under **Models**, **Installed**. One click fetches the file, and a model that is loaded is loaded again with it as soon as no answer is being written.

If the graphics memory has no room for the image part next to the model, LU loads the model without it and says so in the model menu of the chat. The model then works from the list of buttons and fields. A smaller context makes room.

On macOS and Linux there is no list of buttons and fields. A model without image input cannot see the screen there, and LU says so in one sentence.

You can choose a local model or a cloud model with image input instead.

**Holo 3.1 9B** is a model made for this job and can be downloaded from the model catalog. It is marked **Beta**: in our test on Windows it finished a simple typing task in 1 of 3 runs. It is recommended from 16 GB of video memory. On a 12 GB card it does not fit next to a 9B chat model, and each switch between the two took about 20 seconds.

What worked best in our Windows test was the plain setup: a 9B chat model without image input, working from the list of buttons and fields. Typing a note in Notepad by voice took 11 to 22 seconds from the end of the command to the spoken result and succeeded in 6 of 6 runs. That was measured before the question in every new chat existed. In a new chat your click on **Allow** comes on top.

A screen task ends after at most 25 steps or 8 minutes.

## How a task shows up

A screen task looks like any other tool call. The chat and the voice transcript show a block for it that you can open, and the status line says **Working on the screen** with the current step. In Voice it says **Waiting for your answer** while a question is open and **Paused** while the task is paused.

Each look at the screen appears as a small picture on that block, and a click opens it large. The pictures live in memory only, at most 24 of them. They are not written to the conversation file and are gone after a restart. If a password field had the focus, the block says so and shows no picture. With a cloud model as the model that looks at the screen, the screenshots go to that provider.

## Systems

### Windows

Everything described here, including the list of buttons and fields and the autonomous mode. All our tests with a real pointer and real key presses ran on Windows.

### macOS

Mouse, keyboard and screenshots. The list of buttons and fields is not available, so the model needs image input. For the same reason LU cannot name what a click would press here: every click is asked with that reason and needs your click, also in a voice session.

macOS has to grant LU two permissions first, Accessibility and Screen Recording. They come on top of the question LU asks in every new chat: allowing computer control in a chat does not grant the macOS permissions, and granting them does not answer the question in the chat. When one is missing, LU asks above the input field under the title "macOS has to allow this first". It lists both permissions with their state and an **Open System Settings** button for each, which asks macOS and opens the right list. LU checks every second and continues the waiting task by itself once both are granted. Screen Recording takes effect only after LU was quit and opened again, and the question says so. The same lines stand under the Computer control switch while something is missing. In a voice session LU says that the Mac has to allow it first, and a spoken yes does not answer that.

A build that is not signed with a Developer ID, such as one you build yourself, has no fixed signature, so macOS identifies it by the hash of its code. Every new build of that kind is a different app to macOS, and a permission granted to the build before no longer counts. System Settings does not show that: LU still stands in the list, even switched on, and the question keeps saying the permission is missing. For that case each line gets a **Reset and ask again** link once you have clicked its button. It makes macOS drop the old entry for LU and asks again for the build that is running. If LU is not in the list afterwards, add it with the plus button. With such a build, expect to grant both permissions again after every new build.

Neither permission needs an entry in the app's Info.plist or an entitlement.

This permission path compiles and its parts are unit tested, but it has not been confirmed in the running app on a real Mac yet. The question is tested against a simulated system only.

### Linux

X11 sessions only. Under Wayland an app cannot see other windows or send them input, and LU says so. Computer control has not been run on Linux.

## Known limits

- The shrinking window, the glow, the question, the pause on a real mouse and both shortcuts ran in the app on one Windows 10 machine with two screens at 100 percent scaling. Other scaling factors have not been tried, and nothing of this has run in the app on macOS or Linux.
- Eight corrections were made after that run, among them the reason on a sensitive action in a supervised session and the window that comes back to the front before a step. They ran in tests on a Mac and have not been checked again in a real window. The same holds for ten fixes from a security review before the release, among them the rule that no key press puts a character into a password field and the question before a double click on a program.
- The card that asks at the first use in a chat ran in the app on the same Windows machine, in the chat and in a voice session. In the Code tab and after a restart of the app it has run in automated tests only.
- With a model that sees, and with one that does not, a task started on that machine without any question about image input. The case of an image part that is installed but not loaded has run in tests only.
- What a voice session does with the panel and the pause ran on the same Windows machine: pausing by voice, the question, ending the task with the voice session, and the levels of **Where it may work**. The speech was a recording played into the app as the microphone.
- While LU is the panel, the Voice surface is not shown. The switches of Voice and the light switch are out of reach until the task is over.
- The glow exists on Windows only. On macOS the panel shows without it and has square corners, on Linux the window does not shrink.
- An instruction you add while LU is paused reaches the model with its next step. If the task ends without another step, it is not used.
- Where the window does not shrink, the question of a supervised session appears in LU's window, which takes the focus for a moment. An open menu in the other app closes when that happens. LU hands the focus back before it acts.
- LU works in the foreground only. It does not work in a hidden desktop or in the background while you use the pointer.
- Small local models misjudge when a task is finished. A task can end as stopped although the work on the screen is done.
- Text on the screen can try to give the model instructions. LU marks what it reads from the screen as untrusted and asks before sensitive actions, but supervised mode is the safe choice for anything that matters.
- Pausing an autonomous task with a key press on Windows is only partly tested. Keys sent by a script did not interrupt the task, as intended. A key pressed by hand could not be produced in a scripted test.
- The question before a button without a name and before Alt with a letter, and the answer to a spoken yes at the card, were added after the run on Windows. They have run in automated tests only.
- On a Mac, computer control is in the app but not fully tested yet. On Linux no real mouse, keyboard or screen action has been tested.
