# Voice

Talk to LU and hear it answer. Speech recognition, the voice and the turn taking run on your computer. The model that answers is the chat model you already picked.

Voice is its own surface in the main navigation. It does not change the chat.

Voice is in beta in 3.0.6, and the app shows the word Beta next to the title. It is new: it runs on the computers we tested, and yours may still show rough edges. It can still change, and [What has been tested](#what-has-been-tested) says which parts ran in the real app and which did not.

## What you need

- Windows 10 or 11, macOS 14 or newer, or Linux. The check in the real app ran on Windows, and on a Mac Voice has been tried by hand in the app, see [What has been tested](#what-has-been-tested).
- A microphone and speakers or a headset.
- A chat model. A local model works, and so does any other provider you set up in LU.
- Local mode. With the Cloud switch on, Voice is hidden: LU Cloud has no voice service yet.
- Room for the voice engine. In our measurement on a Mac the setup downloaded about 0.7 GB of packages and models. The setup shows the exact download and disk size for your system before anything starts.

## Set it up

1. Open **Voice**.
2. The first time, LU shows what it will download and where it stores it. Open **What is downloaded** to see every part and the credits of the models.
3. Pick a voice, or keep Alba.
4. Click **Install**. LU fetches its own Python, the packages and the models, and checks every file against a checksum. You can cancel and continue later. Nothing is installed outside LU's own folder.

On our Windows test machine a first setup took 7.5 to 7.9 minutes.

**Repair** in the Voice settings checks the packages and every model file and downloads again only what is missing or does not match. **Uninstall** removes the voice engine and its models and nothing else.

## The voice

LU can speak in fifteen English voices: Alba, Anna, Azelma, Charles, Eponine, Eve, Fantine, George, Jane, Javert, Marius, Mary, Michael, Paul and Vera. The list shows names only. The sources of the voices give no reliable information about accent or gender, so LU does not claim any.

You pick a voice in the setup before anything is downloaded, and Alba is the default. An installation holds the models and one voice. When you change the voice later in the Voice settings, LU fetches only that one file (6 to 8 MB) and installs nothing else again. On our Windows test machine that took about 3 seconds. The next session speaks in the new voice. You can change the voice while a session runs, and the change applies to the next session.

**Listen** in the Voice settings plays one short sentence in the chosen voice. It needs the installed voice engine, so there is no preview before the setup. If the engine is not running, Listen starts it first: about 17 seconds until the sentence played in our Windows test, about 2 seconds once the engine was up. Listen is off while a session runs.

## A session

Click **Start voice**. The first start after a fresh setup or after a restart of LU is slow, because the engine and the model have to load. Across our Windows runs it took between 23 and 63 seconds, and about one second once everything was warm. With a local model LU also warms the model up before it says it is ready. A model on Ollama is asked for the context window the chat uses, so going from Chat to Voice does not load it again. A start does not wait behind the memory step of the last chat answer either: it ends that step first.

A short, quiet chord tells you that the session is listening. It lasts 1.3 seconds and is much quieter than the voice. **Play a short sound when a session starts listening** in the Voice settings switches it off. There is no sound at the end of a session.

You do not have to wait for the chord. The microphone is open from the click, and what you say before the session is connected is kept for up to 60 seconds and answered as soon as Voice is up. A session that starts muted keeps nothing.

Then just talk. LU hears when you are done and answers. The transcript shows what was understood and what was said, and the session is saved as a normal conversation in your chat history.

In our Windows tests (RTX 3060 with 12 GB, a local 9B model) the answer started 1.6 to 3.1 seconds after the end of the question. On an M5 Pro Mac it was 1.4 to 2.0 seconds.

Click **Stop** to end the session. Leaving the Voice surface ends it too, and LU tells you so when you come back. The voice engine shuts down five minutes after the last session.

An error ends a session only if the voice engine cannot recover from it, and the session then says why. Any other error is written to the log. Where you would miss something, for example a sentence that could not be spoken, one line under the status says so until you speak again.

## The switches at the top

Next to the title **Voice** sits a row of four small buttons of the same size. Each has a tooltip, shows whether it is on, and can be reached and switched with the keyboard. All of them can be moved while a session runs, and the session follows at once.

- **Voice settings** (the gear) holds the microphone, the start sound, the thinking length, the voice, repair and uninstall.
- **Agent** lets the model use tools. With it off, the session is a plain conversation without tools, without a screen task and without a question about one. The button is off and says why when the chat model cannot use tools.
- **Where it may work** sets how far the tools reach.
- **Thinking** decides whether the model may think before it answers.

If you switch **Agent** off or go back to **Workspace only** while a screen task of the session runs, the task ends like a stop.

### Where it may work

**Workspace only** is the default. Files can only be read and written inside the folder of the session: its own folder, or the one you pick under **Choose the workspace folder**. LU enforces that limit itself and does not leave it to the model. A command starts in that folder and LU asks before every single one, also when your permissions let commands run by themselves, because a running program cannot be held inside a folder. A command that names a place outside the folder is refused without being run. There is no screen at this level. If you ask for something on the screen, LU starts no part of computer control, so you see no panel, no glow and no question. The model is told to point you to **Whole computer**.

**Sandbox** is shown but locked. LU cannot run commands in an isolated environment yet, so it does not offer one.

**Whole computer** opens files by any path your own user account can open, commands in any folder with the permissions you set under Agent Permissions, and the screen. LU asks once in a dialog before this level is used for the first time, and your system asks once more in its own window each time LU was started. A session that is starting waits for that answer, and its status says so: the window can open behind others. The system folders and the folders that hold keys and passwords stay closed at this level too. So do single files that hold a token (such as `.netrc` or `.npmrc`), the profiles of browsers and mail programs, the application data of other apps, and LU's own folders. The files your system runs by itself when a terminal or a session starts (such as `.zshrc`, `.bashrc` or the PowerShell profile) and `.gitconfig` can be read at this level and not changed. Choosing it switches computer control on, which is in beta too. On a Mac, computer control is in the app but not fully tested yet. Everything in [COMPUTER-CONTROL.md](COMPUTER-CONTROL.md) still applies: LU asks before it uses an app for the first time and before anything that sends, buys or deletes, never types into a password field and keeps away from the blocked apps.

### Thinking

Thinking is off by default: a spoken conversation is better with quick answers. Switch it on and the model may think first. The thought is never read aloud. It appears in the transcript as the folded Thinking block you know from the chat, with how long it took, and you can open it.

**Thinking length** in the Voice settings sets how long a thought may get, from 128 to 4096 tokens, 512 by default. When a thought gets longer, LU ends it and asks the model again for a direct answer, so you always hear one. The block then says that the thought was ended at the length you set.

Some models write their thoughts into the answer itself, some think although they were asked not to, and some use up their whole answer on the thought. LU takes the thought out in every one of these cases, and when no answer came it asks again without thinking. If the model still says nothing, LU says so aloud instead of staying silent.

For a model that always thinks the button is locked and says so. Such a model thinks unseen and its answer is spoken as usual.

## Memory, and unloading Voice

Voice starts one process of its own, the voice engine. It holds the speech detection, the speech recognition model and the voice, and it loads them when it starts, not when a session starts. On our M5 Pro Mac the engine took 1.2 to 1.3 GB of memory, the same before the first session and after ten questions and answers. On our Windows test machine it took 0.8 to 1.0 GB. The engine runs on the CPU.

The chat model is separate. Voice does not load a second one, it uses the model selected in Chat, where that model runs. A local 9B model took about 10 GB in Ollama in the same measurement.

While the voice engine is in memory, a small light switch appears right next to the title. It shows how much memory the engine holds right now. LU measures that number and does not estimate it. One click ends the session, stops the engine and gives that memory back. A screen task of the session ends with it, like a stop. If a voice session loaded the chat model, the model is unloaded too. A model the chat had in memory already stays. A short line confirms what was freed, and the switch disappears until Voice is loaded again.

Without the click, the engine shuts down by itself five minutes after the last session.

## Interrupting

Speak into an answer and LU stops talking. In our Windows test it was silent 0.45 to 0.62 seconds after the interruption began.

This also works in the first answer of a session, which needs some help from LU. The echo cancellation of the Windows web view turns the microphone down during the first seconds in which the app plays sound, by 13 to 17 dB in our measurement. LU therefore plays a 20 Hz tone for 6 seconds whenever a microphone is opened. The tone is inaudible and lets the echo cancellation settle before the first answer. The microphone also sends silence for the first 0.6 seconds of the first answer, because a short piece of echo got through there in some of our probes with real speakers.

Measured on Windows with a recording played into the app as the microphone: 10 of 10 interruptions of a first answer arrived word for word, and 10 of 10 in later answers. With a real microphone and speakers, a question spoken through the air arrived complete in 3 of 5 sessions and lost its beginning or its end in the other two.

The tone has a cost: while it plays, a voice that reaches the microphone only faintly, for example from across the room, is turned down by about 15 dB. Someone who speaks quietly right after the click can lose the start of the sentence. A headset is not affected.

## Tools

With **Agent** on, the model can use the same tools as in the agent chat in a voice session, with the same permissions, as far as **Where it may work** lets them reach.

A tool call looks the way it does in the chat. The transcript shows a block with the name of the tool, a running state and then the duration, and you can open it to read the arguments and the result. Several calls in a row fold into one line that counts the steps. A long result scrolls inside its block, and you can scroll up in the transcript while the session goes on: it stays where you put it until you speak again. A screen task always keeps its own block, so its pictures stay visible.

If a tool needs your approval, the same bar as in the chat asks in plain words, for example "Voice wants to change a file. Nothing happens until you answer." LU waits. Click **Approve** or **Reject**. This question takes no spoken answer: a spoken **yes** or **no** only answers the questions of computer control, see The screen below.

Local models get a shorter tool list in a voice session (web, files, shell and the screen), so the first answer comes quickly. Image and video generation are not part of it.

## The screen

With **Where it may work** set to **Whole computer**, you can also ask for something on the screen by voice. [COMPUTER-CONTROL.md](COMPUTER-CONTROL.md) describes what LU shows and asks while it works there. This is what a voice session adds:

- The first screen task of a session brings a card onto the voice surface: **Allow computer control in this chat?** LU says aloud that it waits for your click. Only a click on **Allow** allows it. A spoken yes gets the answer "This one needs your click on the screen.", and a spoken **no** or **stop** declines like **Deny**. Until you click **Allow**, LU looks at nothing and does nothing.
- LU asks its questions aloud. **Yes** or **no** answers them, except for a sensitive action, which needs your click. A button without a name counts as one, and so does Alt with a letter on Windows and Linux.
- Where the LU window stays a window (Linux), the question stands above the controls of the session, below the bar that says LU is controlling the computer. On Windows and macOS the window is the small panel during the task, and the question stands in it.
- Say **stop** or **wait** while the task runs and it pauses, exactly as with the pause shortcut. **Hold on** and **pause** do the same. The session goes on, its status reads **Paused**, and the paused view asks whether you take over or let LU continue. That view is answered with a click. A spoken yes does not answer it, and it does not answer the question underneath either. After **Let it continue** LU asks that question aloud again.
- The paused view shows the tool calls of the session and, between them, the thoughts of the model as folded Thinking blocks.
- Only the word alone pauses. A sentence that begins with **wait**, **hold on** or **pause** and goes on, like "Wait, what is two plus two?", is part of the conversation, so LU listens for a moment after such a word before it pauses. **Stop** pauses at once.
- Ending the session ends the task: **Stop**, leaving Voice, or the light switch.
- A screen task ends after 8 minutes at the latest, and the session ends it after 9 minutes even if it is still paused. A pause extends neither.

## Which model

For anything beyond a conversation Voice needs a model that can call tools, and small models lose the thread when they talk. If your chat model takes no tools or is smaller than 7B, the empty Voice surface says so in one line. A 9B model such as Qwen 3.5 9B is a good start on a 12 GB card.

## Privacy

- Your microphone audio goes to the voice engine on your own computer and nowhere else. Speech recognition and the voice run locally.
- The text of the conversation goes to the chat model you chose. With a local model nothing leaves the computer. With a model from a provider you connected yourself, the text goes to that provider, exactly as in the chat. LU Cloud models are not available in Voice.
- LU stores your microphone choice, your voice, whether a session starts muted, whether the start sound plays, and how the switches at the top stand. It does not store audio.

## What has been tested

Windows is the only system on which the real app has run through all of this: setup, sessions, tools with approval, the fifteen voices, Listen, the start sound, interruptions, the switches at the top, the levels of **Where it may work**, thinking, unloading, and screen tasks by voice with the card that asks first, their questions and the pause. That was one Windows 10 machine with two screens at 100 percent scaling and a local 9B model. For most of it the speech was a recording played into the app as the microphone, so what a person hears and says through the air is covered only by the measurements under [Interrupting](#interrupting).

Eight corrections were made after that run. A sensitive action is asked with its reason in a supervised session too and cannot be confirmed by voice, a spoken yes or no that answered a question stays out of the transcript, the window LU works in comes back to the front before a step, a start that waits for the system window says so, the paused view lists only steps that ran, **wait** alone is held for a moment, a path from the root of the drive counts as a place on the drive, and only a fatal error ends a session. These ran in unit tests and in a browser on a Mac. They have not been checked again in the app on Windows.

Later changes ran in automated tests only: the context window a voice session asks Ollama for, the start that no longer waits behind the memory step, the answer to a spoken yes at the card, and the model named on the idle surface and in a saved session.

On macOS the session was tested during development in Chromium and WebKit against the real voice engine, and interrupting the first answer was confirmed by hand with speakers and with a headset. Since then Voice has been tried by hand in the app on a Mac. That was a try by hand and not the point by point run the Windows app got, so this page does not list which parts it covered.

On Linux the packages were built in a container and a session ran there in a browser against the real voice engine. The AppImage, the deb and the rpm for x86_64 were built in an emulated x86_64 environment, and each one contains the files of the voice engine. The app itself has not been run on Linux.

## Known limits

- Voice is English only: the speech recognition model and the voices are English.
- The voices are fixed. LU does not clone a voice from a recording.
- Speaking while LU speaks relies on the echo cancellation of the system. With loud speakers and no headset the first words of an interruption can be quiet or missing.
- A first start after setup or after a restart takes much longer than later ones.
- The voice engine uses the CPU. It does not need a graphics card, and it does not use one.

## Credits

Speech recognition: Whisper base.en through faster-whisper (MIT). Voice: Pocket TTS by Kyutai, licensed under CC BY 4.0. Voice "alba" from recordings by Alba MacKenna (kyutai/tts-voices, alba-mackenna/casual.wav), licensed under CC BY 4.0. Twelve voices (anna, azelma, charles, eponine, eve, fantine, george, jane, mary, michael, paul, vera) from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, licensed under CC BY 4.0. Two voices (javert, marius) from the Unmute Voice Donation Project, released as CC0. The setup and the Voice settings show the credit line of the voice you chose. Pipeline: Pipecat (BSD-2-Clause), with Silero VAD (MIT) and Smart Turn (BSD-2-Clause).

The full list is in [third-party/VOICE-AND-COMPUTER-NOTICES.md](third-party/VOICE-AND-COMPUTER-NOTICES.md).
