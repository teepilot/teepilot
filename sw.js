self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : { title: 'TeePilot', body: 'Match funnen!' };
    
    const options = {
        body: data.body,
        icon: 'TeePilot-Logo.png',
        badge: 'TeePilot-Logo.png',
        vibrate: [100, 50, 100],
        data: { url: 'https://teepilot.github.io/teepilot/tjanster.html' }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});