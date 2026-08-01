# Reactions

Reactions are unavailable with this plugin's current authentication. The bot
runs unattended as an application, while Microsoft Graph requires a signed-in
user to add or remove a Teams reaction.

The `react` tool remains visible so the limitation is explicit. It returns a
clear error and does not affect replies, edits, attachments or proactive sends.

## What will not fix it

- Adding Microsoft Graph application permissions
- Adding resource-specific consent to the Teams manifest
- Granting `ChatMessage.ReadWrite.All`
- Switching from the beta Graph endpoint to v1.0

Microsoft's
[`setReaction` documentation](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-beta)
lists delegated permissions for chats and channels and does not support
application permissions.

Supporting reactions would require a separate browser sign-in and delegated
token flow. Reactions would then appear as the signed-in person, not as the bot.
That authentication model is not implemented.
