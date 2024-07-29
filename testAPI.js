const url = `https://mainnet.helius-rpc.com/?api-key=6b96dac6-8b2c-4034-bd26-ea942a8d190f`;

const getAssetsWithNativeBalance = async () => {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'my-id',
                method: 'getAssetsByOwner',
                params: {
                    ownerAddress: 'CieWgWEKEB1xmnYkJb2fGEn6ntMfeTvtHr4dL4nrZypr',
                    displayOptions: {
                        showFungible: true,
                        showNativeBalance: true,
                    },
                },
            }),
        });

        const data = await response.json();
        console.log(JSON.stringify(data, null, 2)); // Displaying the full expanded JSON response
    } catch (error) {
        console.error('Error fetching assets:', error);
    }
};

getAssetsWithNativeBalance();