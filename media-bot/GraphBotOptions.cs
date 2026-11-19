namespace MediaBot;

/// <summary>Configuration for the real Teams bot (section "GraphBot"). Secrets come from env/Key Vault, not appsettings.</summary>
public sealed class GraphBotOptions
{
    /// <summary>Entra app (client) id of the bot. Must be multi-tenant so customer tenants can host it.</summary>
    public string AppId { get; set; } = "";

    /// <summary>Client secret for the app. Use Key Vault / env var GraphBot__AppSecret.</summary>
    public string AppSecret { get; set; } = "";

    /// <summary>Display name when joining as a guest (JoinAs=guest). When JoinAs=app, Teams shows the bot registration name.</summary>
    public string DisplayName { get; set; } = "Interview Assistant";

    /// <summary>"app" joins as the bot application (needs Calls.JoinGroupCall.All or RSC). "guest" joins anonymously and always lands in the lobby.</summary>
    public string JoinAs { get; set; } = "app";

    /// <summary>Public HTTPS URL Teams calls with call-state updates, e.g. https://bot.contoso.com/callback.</summary>
    public string NotificationUrl { get; set; } = "";

    /// <summary>FQDN of this instance (must resolve to the VM public IP and match the certificate), e.g. 1.bot.contoso.com.</summary>
    public string ServiceFqdn { get; set; } = "";

    /// <summary>Thumbprint of the TLS cert for ServiceFqdn, installed in LocalMachine\My on the VM.</summary>
    public string CertificateThumbprint { get; set; } = "";

    /// <summary>Public IP of the VM, or 0.0.0.0 to let the platform detect it.</summary>
    public string InstancePublicIpAddress { get; set; } = "0.0.0.0";

    /// <summary>Public TCP port mapped to the media listener (default 8445 in Microsoft samples).</summary>
    public int InstancePublicPort { get; set; } = 8445;

    /// <summary>Local TCP port the media platform listens on.</summary>
    public int InstanceInternalPort { get; set; } = 8445;

    /// <summary>Graph base URL. Change only for sovereign clouds.</summary>
    public string GraphBaseUrl { get; set; } = "https://graph.microsoft.com/v1.0";
}

public sealed class SpeechOptions
{
    public string Key { get; set; } = "";
    public string Region { get; set; } = "";
    public string Language { get; set; } = "en-US";
}
