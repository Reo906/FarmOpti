class VoiceInterfaceError(RuntimeError):
    """Base error that callers can safely map to an API response."""


class VoiceConfigurationError(VoiceInterfaceError):
    """Raised when required voice configuration is absent or invalid."""


class VoiceInputError(VoiceInterfaceError):
    """Raised when audio or text input cannot be accepted."""


class VoiceProviderError(VoiceInterfaceError):
    """Raised when the speech provider rejects or fails a request."""
